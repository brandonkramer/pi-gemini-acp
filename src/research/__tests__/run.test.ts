import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResearchSource } from "../../types.js";
import { runResearch } from "../run.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-research-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runResearch", () => {
	it("runs local research over supplied sources", async () => {
		const result = await runResearch({
			query: "alpha",
			rootDir,
			sources: [
				{
					title: "Alpha",
					url: "https://example.com/a",
					text: "alpha source text",
				},
			],
		});
		expect(result.mode).toBe("local");
		expect(result.findings[0]?.text).toContain("alpha");
		expect(result.responseId).toBeTruthy();
	});

	it("hydrates missing source text when requested", async () => {
		const result = await runResearch(
			{
				query: "alpha",
				rootDir,
				hydrateSources: true,
				sources: [{ title: "Alpha", url: "https://example.com/a" }],
			},
			{
				hydrator: {
					hydrate: async (source: ResearchSource) => ({
						...source,
						text: "hydrated text",
						hydrated: true,
					}),
				},
			},
		);
		expect(result.sources[0]?.hydrated).toBe(true);
		expect(result.findings[0]?.text).toBe("hydrated text");
	});
});
