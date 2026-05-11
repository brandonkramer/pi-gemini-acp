import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openResponseCacheDb } from "../cache-db.ts";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-cache-db-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("ResponseCacheDatabase", () => {
	it("inserts, looks up, and increments hit counts", async () => {
		const db = await openResponseCacheDb({ rootDir });
		try {
			db.put({
				cacheKey: "key-a",
				responseId: "response-a",
				tool: "gemini_extract",
				bytes: 123,
			});
			const row = db.lookup("key-a", 1000);
			expect(row).toMatchObject({
				cacheKey: "key-a",
				responseId: "response-a",
				hitCount: 1,
				lastHitAt: 1000,
			});
			expect(db.summary()).toMatchObject({ rowCount: 1, hitCount: 1 });
		} finally {
			db.close();
		}
	});

	it("expires stale rows on lookup", async () => {
		const db = await openResponseCacheDb({ rootDir });
		try {
			db.put({
				cacheKey: "key-b",
				responseId: "response-b",
				tool: "gemini_search",
				expiresAt: 10,
			});
			expect(db.lookup("key-b", 20)).toBeUndefined();
			expect(db.summary().rowCount).toBe(0);
		} finally {
			db.close();
		}
	});

	it("stores embeddings and cascades them when cache rows are removed", async () => {
		const db = await openResponseCacheDb({ rootDir });
		try {
			db.put({
				cacheKey: "key-c",
				responseId: "response-c",
				tool: "gemini_extract",
			});
			db.putEmbedding({
				responseId: "response-c",
				tool: "gemini_extract",
				recallText: "tool: gemini_extract",
				model: "fake-embedding",
				embedding: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
			});
			expect(db.embeddingSummary("fake-embedding").rowCount).toBe(1);

			db.clear("gemini_extract");

			expect(db.embeddingSummary("fake-embedding").rowCount).toBe(0);
			if (db.sqliteVecAvailable) {
				const vectorRows = db.db
					.prepare("SELECT response_id FROM embeddings_vec WHERE response_id = ?")
					.all("response-c");
				expect(vectorRows).toHaveLength(0);
			}
		} finally {
			db.close();
		}
	});
});
