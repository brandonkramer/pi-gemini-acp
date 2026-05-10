/**
 * @fileoverview Usage-specific tests for the Gemini-backed summarize model
 * adapter. Verifies cost estimates, model fallback, and error paths.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import type { SummarizeRunResult } from "../../prompt/summarize.js";
import { estimateCost } from "../../tools/cost-estimate.js";
import { createGeminiSummarizeAdapter } from "../gemini-summarize.js";
import type { ModelRequest } from "../types.js";

function mockRun(overrides?: { result?: SummarizeRunResult }) {
	return vi.fn().mockResolvedValue(
		overrides?.result ?? {
			provider: "gemini-acp",
			summary: "A short summary.",
			summaryLength: 16,
			summaryTruncated: false,
			source: {
				kind: "content",
				contentLength: 100,
				preparedLength: 100,
				truncated: false,
				maxSourceCharacters: 20000,
			},
		},
	) as Mock;
}

describe("adapter usage", () => {
	it("populates usage on successful run", async () => {
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "summarize",
			input: "Some input text to summarize.",
		};
		const result = await adapter.run<{ summary: string }>(request);
		const usage = result.usage;
		expect(usage).toBeDefined();
		if (!usage) throw new Error("usage expected");
		expect(usage.provider).toBe("gemini-acp");
		expect(usage.model).toBe("gemini-1.5-flash");
		expect(usage.inputTokens).toBeGreaterThan(0);
		expect(usage.outputTokens).toBeGreaterThan(0);
		expect(usage.totalTokens).toBeGreaterThan(0);
		expect(usage.costUSD).toBeGreaterThan(0);
	});

	it("token counts match estimateCost output", async () => {
		const input = "Some input text to summarize.";
		const summary = "A short summary.";
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = { task: "summarize", input };
		const result = await adapter.run<{ summary: string }>(request);
		const expected = estimateCost(input, summary, {
			model: "gemini-1.5-flash",
		});
		const usage = result.usage;
		expect(usage).toBeDefined();
		if (!usage) throw new Error("usage expected");
		expect(usage.inputTokens).toBe(expected.inputTokens);
		expect(usage.outputTokens).toBe(expected.outputTokens);
		expect(usage.totalTokens).toBe(expected.totalTokens);
		expect(usage.costUSD).toBe(expected.costUsd);
	});

	it("falls back to default model when result.model is undefined", async () => {
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "summarize",
			input: "Some input.",
		};
		const result = await adapter.run<{ summary: string }>(request);
		const usage = result.usage;
		expect(usage).toBeDefined();
		if (!usage) throw new Error("usage expected");
		expect(usage.model).toBe("gemini-1.5-flash");
	});

	it("picks up model passed through result.model", async () => {
		const run = mockRun({
			result: {
				provider: "gemini-acp",
				summary: "A short summary.",
				summaryLength: 16,
				summaryTruncated: false,
				source: {
					kind: "content",
					contentLength: 100,
					preparedLength: 100,
					truncated: false,
					maxSourceCharacters: 20000,
				},
				model: "gemini-1.5-pro",
			},
		});
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "summarize",
			input: "Some input.",
		};
		const result = await adapter.run<{ summary: string }>(request);
		const usage = result.usage;
		expect(usage).toBeDefined();
		if (!usage) throw new Error("usage expected");
		expect(usage.model).toBe("gemini-1.5-pro");
		const expectedFlash = estimateCost("Some input.", "A short summary.", {
			model: "gemini-1.5-flash",
		});
		const expectedPro = estimateCost("Some input.", "A short summary.", {
			model: "gemini-1.5-pro",
		});
		expect(usage.costUSD).toBe(expectedPro.costUsd);
		expect(usage.costUSD).toBeGreaterThan(expectedFlash.costUsd);
	});

	it("still throws on result.error and does not return usage", async () => {
		const run = mockRun({
			result: {
				provider: "gemini-acp",
				summary: "",
				summaryLength: 0,
				summaryTruncated: false,
				source: {
					kind: "content",
					contentLength: 0,
					preparedLength: 0,
					truncated: false,
					maxSourceCharacters: 20000,
				},
				error: {
					code: "GEMINI_ACP_UNAVAILABLE",
					message: "ACP is down",
					retryable: false,
				},
			},
		});
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "summarize",
			input: "Some input.",
		};
		await expect(adapter.run(request)).rejects.toThrow("ACP is down");
	});
});
