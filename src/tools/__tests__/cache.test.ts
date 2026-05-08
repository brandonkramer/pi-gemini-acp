import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../recall/embedder.js";
import { openResponseCacheDb } from "../../storage/cache-db.js";
import { storeResult } from "../../storage/results.js";
import { withToolResponseCache } from "../cache.js";
import { toolResult } from "../result.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-tool-cache-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("withToolResponseCache", () => {
	it("returns a cached shell without invoking the live tool twice", async () => {
		const execute = vi.fn(async () =>
			toolResult({ text: "live result", data: { text: "live result" } }),
		);
		const options = {
			toolName: "gemini_extract" as const,
			inputs: { content: "alpha", prompt: "extract" },
			rootDir,
			execute,
		};

		const first = await withToolResponseCache(options);
		const second = await withToolResponseCache(options);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(first.content[0]?.text).toBe("live result");
		expect(second.content[0]?.text).toContain("[cache: hit");
		expect(second.details.data).toMatchObject({
			cacheStatus: { hit: true },
		});
	});

	it("can short-circuit through lexical recall after exact-cache miss", async () => {
		const firstExecute = vi.fn(async () =>
			toolResult({ text: "prior search", data: { text: "prior search" } }),
		);
		await withToolResponseCache({
			toolName: "gemini_search",
			inputs: { query: "dog parks" },
			rootDir,
			execute: firstExecute,
		});
		const secondExecute = vi.fn(async () =>
			toolResult({ text: "live search", data: { text: "live search" } }),
		);

		const result = await withToolResponseCache({
			toolName: "gemini_search",
			inputs: { query: "dog parks near me", useRecall: true },
			rootDir,
			useRecall: true,
			recallQuery: "dog parks near me",
			execute: secondExecute,
		});

		expect(firstExecute).toHaveBeenCalledTimes(1);
		expect(secondExecute).not.toHaveBeenCalled();
		expect(result.content[0]?.text).toContain("[recall hit");
		expect(result.details.data).toMatchObject({
			cacheStatus: { hit: true, source: "recall" },
		});
	});

	it("can short-circuit through high-confidence recall after exact-cache miss", async () => {
		const responseId = await seedRecallableShell();
		const execute = vi.fn(async () =>
			toolResult({ text: "live search", data: { text: "live search" } }),
		);

		const result = await withToolResponseCache({
			toolName: "gemini_search",
			inputs: { query: "dog parks", useRecall: true },
			rootDir,
			useRecall: true,
			recallQuery: "dog parks",
			recallEmbedder: fakeEmbedder(),
			execute,
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.content[0]?.text).toContain("[recall hit");
		expect(result.content[0]?.text).toContain(responseId);
		expect(result.details.data).toMatchObject({
			cacheStatus: { hit: true, source: "recall", responseId },
		});
	});
});

async function seedRecallableShell(): Promise<string> {
	const shell = toolResult({
		text: "prior search",
		data: { text: "prior search" },
	});
	const stored = await storeResult(
		{ shell, recallInputs: { query: "dog parks" } },
		{ rootDir },
	);
	const db = await openResponseCacheDb({ rootDir });
	try {
		db.put({
			cacheKey: "prior-cache-key",
			responseId: stored.responseId,
			tool: "gemini_search",
			createdAt: Date.now(),
		});
		db.putEmbedding({
			responseId: stored.responseId,
			tool: "gemini_search",
			recallText:
				"tool: gemini_search\ninputs: dog parks\nresult: prior search",
			model: "fake-embedding",
			embedding: fakeVector(),
		});
	} finally {
		db.close();
	}
	return stored.responseId;
}

function fakeEmbedder(): Embedder {
	return {
		status: vi.fn(async () => ({
			available: true,
			model: "fake-embedding",
			dim: 768,
		})),
		embed: vi.fn(async () => ({
			model: "fake-embedding",
			dim: 768,
			embedding: fakeVector(),
		})),
	};
}

function fakeVector(): number[] {
	return Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
}
