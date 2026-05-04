import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
