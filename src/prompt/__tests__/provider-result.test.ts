import { describe, expect, it } from "vitest";

import {
	abortedResultEnvelope,
	classifyProviderError,
	isAbortError,
	providerError,
} from "../provider-result.ts";

describe("provider-result helpers", () => {
	it("builds canonical Gemini ACP structured errors", () => {
		expect(providerError("GEMINI_ACP_FAILED", "provider_prompt", "failed")).toEqual({
			code: "GEMINI_ACP_FAILED",
			phase: "provider_prompt",
			message: "failed",
			retryable: false,
			provider: "gemini-acp",
		});
	});

	it("classifies already-aborted signals as retryable aborts", () => {
		const controller = new AbortController();
		controller.abort();

		expect(classifyProviderError(new Error("late"), controller.signal)).toEqual({
			code: "GEMINI_ACP_ABORTED",
			message: "Gemini ACP prompt was aborted.",
			retryable: true,
		});
	});

	it("detects DOMException and Error abort shapes", () => {
		const error = new Error("cancelled");
		error.name = "AbortError";

		expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true);
		expect(isAbortError(error)).toBe(true);
	});

	it("classifies trust-shaped failures with custom remediation", () => {
		const result = classifyProviderError(
			new Error("FatalUntrustedWorkspaceError: not trusted"),
			undefined,
			{ trustRequiredMessage: (message) => `remediate: ${message}` },
		);

		expect(result).toEqual({
			code: "GEMINI_ACP_TRUST_REQUIRED",
			message: "remediate: FatalUntrustedWorkspaceError: not trusted",
			retryable: false,
		});
	});

	it("classifies auth and search-grounding shaped failures", () => {
		expect(classifyProviderError(new Error("unauthenticated"))).toMatchObject({
			code: "GEMINI_ACP_UNAUTHENTICATED",
		});
		expect(classifyProviderError(new Error("search unavailable"))).toMatchObject({
			code: "GEMINI_ACP_SEARCH_UNAVAILABLE",
		});
	});

	it("wraps typed empty results with abort envelopes", () => {
		expect(
			abortedResultEnvelope(
				{ provider: "gemini-acp" as const, text: "" },
				"input_validation",
				"aborted early",
			),
		).toEqual({
			provider: "gemini-acp",
			text: "",
			error: {
				code: "GEMINI_ACP_ABORTED",
				phase: "input_validation",
				message: "aborted early",
				retryable: true,
				provider: "gemini-acp",
			},
		});
	});
});
