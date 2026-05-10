/**
 * @fileoverview Unit tests for the Gemini-backed summarize model adapter.
 */
import { describe, expect, it, vi, type Mock } from "vitest";
import type { SummarizeRunResult } from "../../prompt/summarize.js";
import { createGeminiSummarizeAdapter } from "../gemini-summarize.js";
import type { ModelRequest } from "../types.js";

function mockRun(overrides?: { result?: SummarizeRunResult }) {
	return vi.fn().mockResolvedValue(
		overrides?.result ?? {
			provider: "gemini-acp",
			summary: "mock summary",
			summaryLength: 12,
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

describe("createGeminiSummarizeAdapter", () => {
	it("returns a ModelResponse for summarize task", async () => {
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "summarize",
			input: "Some content to summarize.",
		};
		const result = await adapter.run<{ summary: string }>(request);
		const text = result.text;
		const data = result.data;
		const raw = result.raw;
		const usage = result.usage;
		expect(text).toBe("mock summary");
		expect(data.summary).toBe("mock summary");
		expect(raw).toMatchObject({
			provider: "gemini-acp",
			summary: "mock summary",
		});
		expect(usage).toBeDefined();
		expect(run).toHaveBeenCalledOnce();
		const optionsArg = run.mock.calls[0][0] as {
			content: string;
			prompt?: string;
		};
		expect(optionsArg.content).toBe("Some content to summarize.");
	});

	it("includes custom guidance and maps options to SummarizeOptions", async () => {
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "summarize",
			input: "Some content.",
			prompt: "Focus on the key takeaways.",
			options: {
				style: "bullets",
				sentenceCount: 3,
				bulletCount: 5,
				audience: "engineers",
				title: "My Doc",
				maxSourceCharacters: 5000,
			},
		};
		await adapter.run(request);
		const optionsArg = run.mock.calls[0][0] as {
			content: string;
			prompt: string;
			style: string;
			sentenceCount: number;
			bulletCount: number;
			audience: string;
			title: string;
			maxSourceCharacters: number;
		};
		expect(optionsArg.content).toBe("Some content.");
		expect(optionsArg.prompt).toBe("Focus on the key takeaways.");
		expect(optionsArg.style).toBe("bullets");
		expect(optionsArg.sentenceCount).toBe(3);
		expect(optionsArg.bulletCount).toBe(5);
		expect(optionsArg.audience).toBe("engineers");
		expect(optionsArg.title).toBe("My Doc");
		expect(optionsArg.maxSourceCharacters).toBe(5000);
	});

	it("throws for unsupported extract task", async () => {
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "extract",
			input: "Some content.",
		};
		await expect(adapter.run(request)).rejects.toThrow(
			'gemini-acp adapter does not support task "extract" (only summarize)',
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("propagates abort signal to runSummarize", async () => {
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const controller = new AbortController();
		const request: ModelRequest = {
			task: "summarize",
			input: "Some content.",
		};
		await adapter.run(request, controller.signal);
		expect(run).toHaveBeenCalledOnce();
		const signalArg = run.mock.calls[0][2] as AbortSignal;
		expect(signalArg).toBe(controller.signal);
	});

	it("filters out invalid option values before calling runSummarize", async () => {
		const run = mockRun();
		const adapter = createGeminiSummarizeAdapter(run);
		const request: ModelRequest = {
			task: "summarize",
			input: "Some content.",
			options: {
				style: "weird",
				sentenceCount: "3",
				bulletCount: NaN,
				audience: "",
				title: 42,
				maxSourceCharacters: Infinity,
			},
		};
		await adapter.run(request);
		const optionsArg = run.mock.calls[0][0] as Record<string, unknown>;
		expect(optionsArg.style).toBeUndefined();
		expect(optionsArg.sentenceCount).toBeUndefined();
		expect(optionsArg.bulletCount).toBeUndefined();
		expect(optionsArg.audience).toBeUndefined();
		expect(optionsArg.title).toBeUndefined();
		expect(optionsArg.maxSourceCharacters).toBeUndefined();
	});

	it("throws when runSummarize returns an error", async () => {
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
			input: "Some content.",
		};
		await expect(adapter.run(request)).rejects.toThrow("ACP is down");
	});
});
