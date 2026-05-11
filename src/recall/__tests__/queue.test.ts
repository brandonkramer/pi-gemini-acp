import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openResponseCacheDb } from "../../storage/cache-db.ts";
import { storeResult } from "../../storage/results.ts";
import type { Embedder } from "../embedder.ts";
import { drainEmbeddingQueue, enqueueEmbeddingJob } from "../queue.ts";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-recall-"));
});

afterEach(async () => {
	delete process.env.PI_GEMINI_ACP_RECALL;
	await rm(rootDir, { recursive: true, force: true });
});

describe("embedding queue", () => {
	it("embeds queued cache-miss responses with a fake embedder", async () => {
		const embedder = fakeEmbedder();
		const responseId = await seedCachedResponse();

		expect(await enqueueEmbeddingJob({ rootDir, responseId, embedder })).toBe(true);
		expect(await drainEmbeddingQueue({ rootDir, embedder })).toBe(1);

		const db = await openResponseCacheDb({ rootDir });
		try {
			expect(db.embeddingSummary("fake-embedding")).toMatchObject({
				rowCount: 1,
				queueDepth: 0,
				sqliteVecAvailable: true,
			});
			const rows = db.db
				.prepare(
					"SELECT response_id, distance FROM embeddings_vec WHERE embedding MATCH ? AND k = 1",
				)
				.all(JSON.stringify(fakeVector())) as Array<{
				response_id: string;
				distance: number;
			}>;
			expect(rows[0]?.response_id).toBe(responseId);
		} finally {
			db.close();
		}
	});

	it("does not enqueue when recall is disabled by env", async () => {
		process.env.PI_GEMINI_ACP_RECALL = "0";
		const responseId = await seedCachedResponse();
		const embedder = fakeEmbedder();

		expect(await enqueueEmbeddingJob({ rootDir, responseId, embedder })).toBe(false);

		const db = await openResponseCacheDb({ rootDir });
		try {
			expect(db.embeddingSummary("fake-embedding").queueDepth).toBe(0);
			// oxlint-disable-next-line typescript/unbound-method -- vitest's expect() reads the mock's tracked invocations; this binding is irrelevant
			expect(embedder.embed).not.toHaveBeenCalled();
		} finally {
			db.close();
		}
	});

	it("records retry attempts without surfacing embedder failures", async () => {
		const responseId = await seedCachedResponse();
		const embedder = fakeEmbedder(new Error("temporary outage"));
		await enqueueEmbeddingJob({ rootDir, responseId, embedder });

		expect(await drainEmbeddingQueue({ rootDir, embedder, now: 1000 })).toBe(0);

		const db = await openResponseCacheDb({ rootDir });
		try {
			const job = db.nextEmbeddingJobs(1, 1000)[0];
			expect(job).toBeUndefined();
			expect(db.embeddingSummary("fake-embedding").queueDepth).toBe(1);
		} finally {
			db.close();
		}
	});
});

async function seedCachedResponse(): Promise<string> {
	const stored = await storeResult(
		{
			recallInputs: { prompt: "summarize this" },
			shell: {
				content: [{ type: "text", text: "summary result" }],
				details: { data: { summary: "summary result" } },
			},
		},
		{ rootDir },
	);
	const db = await openResponseCacheDb({ rootDir });
	try {
		db.put({
			cacheKey: `cache-${stored.responseId}`,
			responseId: stored.responseId,
			tool: "gemini_summarize",
		});
	} finally {
		db.close();
	}
	return stored.responseId;
}

function fakeEmbedder(error?: Error): Embedder {
	return {
		status: vi.fn(async () => ({
			available: true,
			model: "fake-embedding",
			dim: 768,
		})),
		embed: vi.fn(async () => {
			if (error) throw error;
			return { model: "fake-embedding", dim: 768, embedding: fakeVector() };
		}),
	};
}

function fakeVector(): number[] {
	return Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
}
