import type { StructuredError } from "../types.ts";

/** Stable Gemini ACP provider error codes shared by package workflows. */
export type ProviderErrorCode =
	| "GEMINI_ACP_ABORTED"
	| "GEMINI_ACP_FAILED"
	| "GEMINI_ACP_UNAUTHENTICATED"
	| "GEMINI_ACP_NO_SEARCH_GROUNDING"
	| "GEMINI_ACP_SEARCH_UNAVAILABLE"
	| "GEMINI_ACP_TRUST_REQUIRED"
	| string;

/** Optional metadata for canonical Gemini ACP structured errors. */
export interface ProviderErrorOptions {
	retryable?: boolean;
	cause?: unknown;
	provider?: string | false;
}

/** Custom messages used when mapping thrown provider failures. */
export interface ProviderErrorClassificationOptions {
	abortedMessage?: string;
	failedMessage?: string;
	trustRequiredMessage?: (message: string) => string;
}

/** Minimal provider error classification returned by the shared mapper. */
export interface ClassifiedProviderError {
	code: ProviderErrorCode;
	message: string;
	retryable: boolean;
}

/** Builds the canonical Gemini ACP structured-error envelope. */
export function providerError(
	code: ProviderErrorCode,
	phase: string,
	message: string,
	opts: ProviderErrorOptions = {},
): StructuredError {
	return {
		code,
		phase,
		message,
		retryable: opts.retryable ?? code === "GEMINI_ACP_ABORTED",
		...(opts.provider === false ? {} : { provider: opts.provider ?? "gemini-acp" }),
		...(opts.cause === undefined ? {} : { cause: opts.cause }),
	};
}

/** Detects DOM and Node-style abort errors in one place. */
export function isAbortError(cause: unknown): boolean {
	return cause instanceof DOMException
		? cause.name === "AbortError"
		: cause instanceof Error && cause.name === "AbortError";
}

/** Classifies provider exceptions without losing tool-specific message wording. */
export function classifyProviderError(
	cause: unknown,
	signal?: AbortSignal,
	opts: ProviderErrorClassificationOptions = {},
): ClassifiedProviderError {
	if (signal?.aborted || isAbortError(cause)) {
		return {
			code: "GEMINI_ACP_ABORTED",
			message: opts.abortedMessage ?? "Gemini ACP prompt was aborted.",
			retryable: true,
		};
	}
	const message = cause instanceof Error ? cause.message : undefined;
	if (message && isTrustRequiredText(message)) {
		return {
			code: "GEMINI_ACP_TRUST_REQUIRED",
			message: opts.trustRequiredMessage?.(message) ?? message,
			retryable: false,
		};
	}
	if (message && /auth|unauthenticated|login|credential/iu.test(message)) {
		return {
			code: "GEMINI_ACP_UNAUTHENTICATED",
			message,
			retryable: false,
		};
	}
	if (message && /grounding|google_search|search unavailable/iu.test(message)) {
		return {
			code: "GEMINI_ACP_SEARCH_UNAVAILABLE",
			message,
			retryable: false,
		};
	}
	return {
		code: "GEMINI_ACP_FAILED",
		message: message ?? opts.failedMessage ?? "Gemini ACP prompt failed.",
		retryable: false,
	};
}

/** Wraps a typed empty result with a consistent abort error. */
export function abortedResultEnvelope<T extends object>(
	empty: T,
	phase: string,
	message: string,
): T & { error: StructuredError } {
	return {
		...empty,
		error: providerError("GEMINI_ACP_ABORTED", phase, message),
	};
}

/** Identifies Gemini CLI folder-trust failures without trusting anything silently. */
export function isTrustRequiredText(message: string): boolean {
	return /trust|trusted|untrusted|trusted directory|skip-trust|GEMINI_CLI_TRUST_WORKSPACE/iu.test(
		message,
	);
}
