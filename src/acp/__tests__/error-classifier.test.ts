import { describe, expect, it } from "vitest";

import {
	classifyGeminiError,
	cooldownMs,
	isContextOverflowError,
	isRetryableOnSameAccount,
} from "../error-classifier.ts";
import { JsonRpcResponseError } from "../jsonrpc-stdio.ts";

describe("classifyGeminiError", () => {
	it("classifies JsonRpcResponseError with JSON-RPC error code", () => {
		const error = new Error("server error");
		(error as unknown as { code: number }).code = -32000;
		const result = classifyGeminiError(error);
		expect(result.code).toBe(-32000);
		expect(result.kind).toBe("retryable");
	});

	it("classifies HTTP 429 as quota", () => {
		const error = new Error("too many requests");
		(error as unknown as { statusCode: number }).statusCode = 429;
		const result = classifyGeminiError(error);
		expect(result.code).toBe(429);
		expect(result.kind).toBe("quota");
	});

	it("classifies HTTP 500 as retryable", () => {
		const error = new Error("internal server error");
		(error as unknown as { statusCode: number }).statusCode = 500;
		const result = classifyGeminiError(error);
		expect(result.code).toBe(500);
		expect(result.kind).toBe("retryable");
	});

	it("classifies HTTP 400 as fatal", () => {
		const error = new Error("bad request");
		(error as unknown as { status: number }).status = 400;
		const result = classifyGeminiError(error);
		expect(result.code).toBe(400);
		expect(result.kind).toBe("fatal");
	});

	it("extracts status code from message text (NNN)", () => {
		const error = new Error("server error (503)");
		const result = classifyGeminiError(error);
		expect(result.code).toBe(503);
		expect(result.kind).toBe("retryable");
	});

	it("parses quota reset from message", () => {
		const error = new Error(
			"You have exhausted your capacity. Your quota will reset after 2h21m46s.",
		);
		const result = classifyGeminiError(error);
		expect(result.resetMs).toBeGreaterThan(0);
		expect(result.kind).toBe("quota");
	});

	it("falls back to message regex for quota", () => {
		const error = new Error("rate limited by upstream service");
		const result = classifyGeminiError(error);
		expect(result.code).toBeUndefined();
		expect(result.kind).toBe("quota");
	});

	it("falls back to message regex for retryable", () => {
		const error = new Error("temporary failure, try again");
		const result = classifyGeminiError(error);
		expect(result.code).toBeUndefined();
		expect(result.kind).toBe("retryable");
	});

	it("classifies unknown errors as fatal", () => {
		const error = new Error("invalid API key");
		const result = classifyGeminiError(error);
		expect(result.code).toBeUndefined();
		expect(result.kind).toBe("fatal");
	});

	it("handles non-Error objects with statusCode", () => {
		const error = { statusCode: 429, message: "rate limit hit" };
		const result = classifyGeminiError(error);
		expect(result.code).toBe(429);
		expect(result.kind).toBe("quota");
	});

	it("handles null/undefined gracefully", () => {
		expect(classifyGeminiError(null).kind).toBe("fatal");
		expect(classifyGeminiError(undefined).kind).toBe("fatal");
	});
});

describe("isRetryableOnSameAccount", () => {
	const failoverCodes = [429, -32000] as const;

	it("returns true for configured HTTP code", () => {
		const error = new Error("quota");
		(error as unknown as { statusCode: number }).statusCode = 429;
		expect(isRetryableOnSameAccount(error, failoverCodes)).toBe(true);
	});

	it("returns true for configured JSON-RPC code", () => {
		const error = new Error("server error");
		(error as unknown as { code: number }).code = -32000;
		expect(isRetryableOnSameAccount(error, failoverCodes)).toBe(true);
	});

	it("returns false for non-configured code", () => {
		const error = new Error("bad request");
		(error as unknown as { statusCode: number }).statusCode = 400;
		expect(isRetryableOnSameAccount(error, failoverCodes)).toBe(false);
	});

	it("returns false when quota reset is advertised in message", () => {
		const error = new Error("You have exhausted your capacity. Your quota will reset after 1h.");
		expect(isRetryableOnSameAccount(error, failoverCodes)).toBe(false);
	});

	it("falls back to message regex", () => {
		expect(isRetryableOnSameAccount(new Error("quota exceeded"), [])).toBe(true);
		expect(isRetryableOnSameAccount(new Error("rate limit hit"), [])).toBe(true);
		expect(isRetryableOnSameAccount(new Error("generic error"), [])).toBe(false);
	});

	it("does not retry a context overflow even with a configured code", () => {
		const error = new JsonRpcResponseError(-32000, "Internal error", {
			message: "The input token count exceeds the maximum number of tokens allowed 1048576.",
		});
		expect(isRetryableOnSameAccount(error, failoverCodes)).toBe(false);
		expect(classifyGeminiError(error).kind).toBe("fatal");
	});
});

describe("isContextOverflowError", () => {
	it("matches Gemini's token-limit message in the error message or data", () => {
		expect(
			isContextOverflowError(
				new Error("The input token count exceeds the maximum number of tokens allowed 1048576."),
			),
		).toBe(true);
		expect(
			isContextOverflowError(
				new JsonRpcResponseError(-32603, "Internal error", {
					details: "The input token count (1200000) exceeds the maximum number of tokens allowed",
				}),
			),
		).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isContextOverflowError(new Error("quota exceeded"))).toBe(false);
		expect(isContextOverflowError(undefined)).toBe(false);
	});
});

describe("cooldownMs", () => {
	it("parses quota reset from message", () => {
		const error = new Error("quota will reset after 1h");
		const ms = cooldownMs(error, 60);
		expect(ms).toBe(3600_000);
	});

	it("falls back to default when no reset in message", () => {
		const error = new Error("rate limited");
		(error as unknown as { statusCode: number }).statusCode = 429;
		const ms = cooldownMs(error, 300);
		expect(ms).toBe(300_000);
	});
});
