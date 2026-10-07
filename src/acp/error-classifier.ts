/**
 * @file Classify Gemini ACP errors for retry and failover decisions. Real ACP errors arrive over
 *   JSON-RPC stdio as `JsonRpcResponseError` instances with a JSON-RPC error `code` (-32xxx range).
 *   HTTP status codes (`statusCode`/`status`) may also appear from intermediate layers or tests.
 *   This classifier extracts whichever code is available and classifies the error consistently so
 *   `failover.codes` works with both error shapes.
 */
import { parseQuotaResetMs } from "../api/quota-cache.ts";

/** Classification of a Gemini ACP error for retry/failover decisions. */
export type ErrorKind = "quota" | "retryable" | "fatal";

/** Result of classifying a Gemini ACP error. */
export interface ClassifiedGeminiError {
	/** Whether the error is quota exhaustion, transient/retryable, or fatal. */
	kind: ErrorKind;
	/**
	 * Numeric code extracted from the error, if available. - `JsonRpcResponseError` → JSON-RPC error
	 * code (e.g. -32000) - HTTP-proxied errors → HTTP status code (e.g. 429) - Extracted from message
	 * text → HTTP status code
	 */
	code?: number;
	/** Parsed quota reset duration in ms, if parseable from the error message. */
	resetMs?: number;
}

/**
 * Classifies a Gemini ACP error to determine retry/failover behavior.
 *
 * Extraction priority: 1. `JsonRpcResponseError` with numeric `.code` → JSON-RPC error code 2. Any
 * object with `.statusCode` → HTTP status code 3. Any object with `.status` → HTTP status code 4.
 * Message text pattern `(NNN)` → HTTP status code 5. Message regex heuristics → `kind` only (no
 * code)
 */
export function classifyGeminiError(error: unknown): ClassifiedGeminiError {
	const { message, raw: _raw } = extractErrorInfo(error);
	const code = extractCode(error, message);
	const resetMs = parseQuotaResetMs(message);
	// The same input fails the same way on every account; retrying only wastes time.
	const kind = isContextOverflowError(error) ? "fatal" : classifyKind(message, code);
	return { kind, code, resetMs };
}

/**
 * Returns true when the error should trigger retry on the same account. Used by
 * `AccountPool.isRetryableOnSameAccount`.
 */
export function isRetryableOnSameAccount(
	error: unknown,
	failoverCodes: readonly number[],
): boolean {
	const { message } = extractErrorInfo(error);
	// The same input overflows again; neither retry nor failover helps.
	if (isContextOverflowError(error)) return false;
	const code = extractCode(error, message);

	// If a code was extracted and it's in the failover list, retry.
	if (code !== undefined && failoverCodes.includes(code)) return true;

	// If the message explicitly advertises a quota reset window, retrying
	// the same account is guaranteed to fail — fail over instead.
	if (parseQuotaResetMs(message) !== undefined) return false;

	// Fallback: message regex heuristics (Gemini CLI may change error text).
	return /exhausted|quota|capacity|rate.limit/iu.test(message);
}

/**
 * Returns the cooldown duration in ms for the given error. Parses quota reset from the message,
 * falls back to `fallbackSeconds` if unavailable.
 */
export function cooldownMs(error: unknown, fallbackSeconds: number): number {
	const { message } = extractErrorInfo(error);
	return parseQuotaResetMs(message) ?? fallbackSeconds * 1000;
}

/**
 * Returns true when Gemini rejected the request because its input exceeds the model's token limit,
 * e.g. "The input token count exceeds the maximum number of tokens allowed 1048576." Gemini CLI may
 * put the backend message in the JSON-RPC error message or in its `data`.
 */
export function isContextOverflowError(error: unknown): boolean {
	const { message } = extractErrorInfo(error);
	const data =
		typeof error === "object" && error !== null && "data" in error
			? (error as { data?: unknown }).data
			: undefined;
	const dataText = data === undefined ? "" : JSON.stringify(data);
	return CONTEXT_OVERFLOW.test(`${message}\n${dataText}`);
}

const CONTEXT_OVERFLOW =
	/input token count (?:\(\d+\) )?exceeds the maximum|exceeds the maximum number of tokens/iu;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ErrorInfo {
	message: string;
	raw: unknown;
}

function extractErrorInfo(error: unknown): ErrorInfo {
	if (error instanceof Error) return { message: error.message, raw: error };
	if (typeof error === "object" && error !== null)
		return { message: JSON.stringify(error), raw: error };
	if (typeof error === "string") return { message: error, raw: error };
	return { message: "", raw: error };
}

function extractCode(error: unknown, message: string): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as Record<string, unknown>;

	// 1. JsonRpcResponseError has a numeric `.code` field (JSON-RPC error code).
	if (typeof record.code === "number") return record.code;

	// 2. HTTP-style status code.
	if (typeof record.statusCode === "number") return record.statusCode;
	if (typeof record.status === "number") return record.status;

	// 3. Extract from message: "server error (500)"
	const match = /\((\d{3})\)/u.exec(message);
	if (match) return parseInt(match[1], 10);

	return undefined;
}

function classifyKind(message: string, code?: number): ErrorKind {
	if (code !== undefined) {
		// HTTP 429 / too many requests
		if (code === 429) return "quota";
		// HTTP 5xx — transient server errors
		if (code >= 500 && code < 600) return "retryable";
		// JSON-RPC server error range (-32000 to -32099) — transient
		if (code >= -32099 && code <= -32000) return "retryable";
		// HTTP 4xx (except 429) — fatal client errors
		if (code >= 400 && code < 500) return "fatal";
	}

	// Fallback: message regex heuristics
	if (/exhausted\s+your\s+capacity|quota\s+exhausted/iu.test(message)) return "quota";
	if (/rate\s*limited|rate.limit/iu.test(message)) return "quota";
	if (/capacity|throttl|try.again|temporar/iu.test(message)) return "retryable";

	return "fatal";
}
