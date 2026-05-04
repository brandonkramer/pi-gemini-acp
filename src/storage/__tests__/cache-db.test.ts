import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openResponseCacheDb } from "../cache-db.js";

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
});
