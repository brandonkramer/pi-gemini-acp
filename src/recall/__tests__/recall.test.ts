import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openResponseCacheDb } from "../../storage/cache-db.ts";
import { storeResult } from "../../storage/results.ts";
import { upsertLexicalRecallEntry } from "../lexical-recall.ts";
import { runRecall } from "../recall.ts";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-recall-query-"));
});

afterEach(async () => {
	delete process.env.PI_GEMINI_ACP_RECALL;
	await rm(rootDir, { recursive: true, force: true });
});

describe("runRecall", () => {
	it("returns local FTS recall hits without an embedding provider", async () => {
		await seedLexicalRecall({
			cacheKey: "cache-fireworks",
			responseId: "response-fireworks",
			tool: "gemini_search",
			createdAt: 2_000,
			inputs: { query: "how do fireworks.ai make models so fast" },
			result: {
				text: "Fireworks.ai is fast because of optimized inference serving, batching, quantization, and GPU scheduling.",
			},
		});

		const result = await runRecall({
			rootDir,
			query: "why is fireworks inference so quick with models",
			tool: "gemini_search",
		});

		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.recallProvider).toBe("fts5");
		expect(result.hits[0]).toMatchObject({
			responseId: "response-fireworks",
			matchType: "fts",
			recallProvider: "fts5",
		});
	});

	it("normalizes legacy tool names to the aggregate public surface", async () => {
		await seedLexicalRecall({
			cacheKey: "cache-summary",
			responseId: "response-summary",
			tool: "gemini_summarize",
			createdAt: 2_000,
			inputs: { content: "local document search recall smoke" },
			result: { text: "Summary of local document search recall smoke." },
		});

		const result = await runRecall({
			rootDir,
			query: "local document search recall smoke",
			tool: "gemini_ask",
		});

		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.hits[0]).toMatchObject({
			responseId: "response-summary",
			tool: "gemini_ask",
		});
	});

	it("returns an empty FTS result instead of falling back to vector recall", async () => {
		const result = await runRecall({ rootDir, query: "dogs" });

		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result).toMatchObject({
			query: "dogs",
			hits: [],
			recallProvider: "fts5",
			totalCandidates: 0,
		});
	});

	it("returns an honest structured error when recall is disabled", async () => {
		process.env.PI_GEMINI_ACP_RECALL = "0";

		const result = await runRecall({ rootDir, query: "dogs" });

		expect(result).toMatchObject({
			error: {
				code: "GEMINI_ACP_RECALL_UNAVAILABLE",
				phase: "recall_preflight",
				retryable: false,
			},
		});
	});
});

async function seedLexicalRecall(options: {
	cacheKey: string;
	responseId: string;
	tool: string;
	createdAt: number;
	inputs: unknown;
	result: unknown;
}): Promise<void> {
	await storeResult(
		{ recallInputs: options.inputs, result: options.result },
		{ rootDir, responseId: options.responseId },
	);
	const db = await openResponseCacheDb({ rootDir });
	try {
		db.put({
			cacheKey: options.cacheKey,
			responseId: options.responseId,
			tool: options.tool,
			model: "gemini-test",
			createdAt: options.createdAt,
		});
	} finally {
		db.close();
	}
	await upsertLexicalRecallEntry({
		responseId: options.responseId,
		tool: options.tool,
		inputs: options.inputs,
		result: options.result,
		rootDir,
	});
}
