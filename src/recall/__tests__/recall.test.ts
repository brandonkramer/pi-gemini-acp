import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../embedder.js";
import { distanceToSimilarity, runRecall } from "../recall.js";
import { openResponseCacheDb } from "../../storage/cache-db.js";
import { storeResult } from "../../storage/results.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-recall-query-"));
});

afterEach(async () => {
	delete process.env.PI_GEMINI_ACP_RECALL;
	await rm(rootDir, { recursive: true, force: true });
});

describe("runRecall", () => {
	it("ranks vector hits and applies threshold, since, and tool filters", async () => {
		await seedEmbedding({
			cacheKey: "cache-alpha",
			responseId: "response-alpha",
			tool: "gemini_search",
			createdAt: 2_000,
			recallText: "tool: gemini_search\ninputs: alpha dogs\nresult: dog parks",
			embedding: basisVector(0),
		});
		await seedEmbedding({
			cacheKey: "cache-beta",
			responseId: "response-beta",
			tool: "gemini_research",
			createdAt: 1_000,
			recallText: "tool: gemini_research\ninputs: beta cats\nresult: cat cafes",
			embedding: basisVector(1),
		});

		const result = await runRecall({
			rootDir,
			query: "dog parks",
			k: 5,
			minScore: 0.8,
			since: new Date(1_500).toISOString(),
			tool: "gemini_search",
			embedder: fakeEmbedder(basisVector(0)),
		});

		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]).toMatchObject({
			responseId: "response-alpha",
			tool: "gemini_search",
			inputsSummary: "alpha dogs",
		});
		expect(result.hits[0]?.similarity).toBeGreaterThan(0.99);
	});

	it("returns an honest structured error when the embedder is unavailable", async () => {
		const result = await runRecall({ rootDir, query: "dogs" });

		expect(result).toMatchObject({
			error: {
				code: "GEMINI_ACP_RECALL_UNAVAILABLE",
				phase: "recall_preflight",
				retryable: false,
			},
		});
	});

	it("returns an honest structured error when recall is disabled", async () => {
		process.env.PI_GEMINI_ACP_RECALL = "0";

		const result = await runRecall({
			rootDir,
			query: "dogs",
			embedder: fakeEmbedder(basisVector(0)),
		});

		expect(result).toMatchObject({
			error: { code: "GEMINI_ACP_RECALL_UNAVAILABLE" },
		});
	});

	it("does not persist query embeddings and can bypass the in-memory query cache", async () => {
		await seedEmbedding({
			cacheKey: "cache-alpha",
			responseId: "response-alpha",
			tool: "gemini_search",
			createdAt: 2_000,
			recallText: "tool: gemini_search\ninputs: alpha\nresult: dog parks",
			embedding: basisVector(0),
		});
		const embedder = fakeEmbedder(basisVector(0));

		await runRecall({ rootDir, query: "dogs", embedder });
		await runRecall({ rootDir, query: "dogs", embedder });
		await runRecall({ rootDir, query: "dogs", embedder, bypassCache: true });

		expect(embedder.embed).toHaveBeenCalledTimes(2);
		const db = await openResponseCacheDb({ rootDir });
		try {
			expect(db.embeddingSummary("fake-embedding").rowCount).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("distanceToSimilarity", () => {
	it("converts vector distance into a bounded similarity", () => {
		expect(distanceToSimilarity(0)).toBe(1);
		expect(distanceToSimilarity(0.25)).toBe(0.75);
		expect(distanceToSimilarity(2)).toBe(0);
	});
});

async function seedEmbedding(options: {
	cacheKey: string;
	responseId: string;
	tool: string;
	createdAt: number;
	recallText: string;
	embedding: number[];
}): Promise<void> {
	await storeResult(
		{
			recallInputs: { query: options.recallText },
			shell: { content: [{ type: "text", text: options.recallText }] },
		},
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
		db.putEmbedding({
			responseId: options.responseId,
			tool: options.tool,
			recallText: options.recallText,
			model: "fake-embedding",
			embedding: options.embedding,
		});
	} finally {
		db.close();
	}
}

function fakeEmbedder(vector: number[]): Embedder {
	return {
		status: vi.fn(async () => ({
			available: true,
			model: "fake-embedding",
			dim: 768,
		})),
		embed: vi.fn(async () => ({
			model: "fake-embedding",
			dim: 768,
			embedding: vector,
		})),
	};
}

function basisVector(index: number): number[] {
	return Array.from({ length: 768 }, (_, current) =>
		current === index ? 1 : 0,
	);
}
