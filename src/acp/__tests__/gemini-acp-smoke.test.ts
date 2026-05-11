import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createGeminiSummarizeAdapter } from "../../adapter/gemini-summarize.ts";
import { runFileAnalyze } from "../../prompt/file-analyze.ts";
import { runImageDescribe } from "../../prompt/image-describe.ts";
import { runSearch } from "../../search/run.ts";

const enabled = process.env.PI_GEMINI_ACP === "1";
const command = process.env.PI_GEMINI_ACP_COMMAND ?? "gemini";
const args = (process.env.PI_GEMINI_ACP_ARGS ?? "--acp").split(" ").filter(Boolean);
const pngBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe.skipIf(!enabled)("opt-in Gemini ACP smoke", () => {
	it("runs configured Gemini ACP search", async () => {
		const result = await runSearch({
			query: "official Gemini API documentation",
			maxResults: 3,
			config: {
				providers: {
					"gemini-acp": {
						enabled: true,
						command,
						args,
						authenticated: true,
						searchGroundingAvailable: true,
					},
				},
			},
		});
		expect(result.error).toBeUndefined();
		expect(result.results.length).toBeGreaterThan(0);
	}, 120_000);

	it("runs configured Gemini ACP file analysis with resource links", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-gemini-smoke-file-"));
		try {
			await writeFile(path.join(cwd, "notes.txt"), "alpha beta gamma", "utf8");
			const result = await runFileAnalyze({
				paths: ["notes.txt"],
				instructions: "Reply with the exact three words in this file.",
				cwd,
				config: fileReadConfig(),
			});
			expect(result.error).toBeUndefined();
			expect(result.text.toLowerCase()).toContain("alpha beta gamma");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 120_000);

	it("preflights Gemini ACP image resource-link support", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-gemini-smoke-image-"));
		try {
			await writeFile(path.join(cwd, "pixel.png"), pngBytes);
			const result = await runImageDescribe({
				imagePath: "pixel.png",
				instructions: "Describe the image in one short sentence.",
				cwd,
				config: fileReadConfig(),
			});
			if (result.error?.code === "GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED") {
				expect(result.image?.kind).toBe("path");
				return;
			}
			expect(result.error).toBeUndefined();
			expect(result.caption?.length).toBeGreaterThan(0);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 120_000);
});

describe("model adapter smoke (mocked ACP)", () => {
	it("exercises summarize adapter end-to-end with mocked transport", async () => {
		const adapter = createGeminiSummarizeAdapter(async () => ({
			provider: "gemini-acp",
			summary: "A concise summary.",
			summaryLength: 17,
			summaryTruncated: false,
			source: {
				kind: "content",
				contentLength: 100,
				preparedLength: 100,
				truncated: false,
				maxSourceCharacters: 20000,
			},
		}));
		const result = await adapter.run<{ summary: string }>({
			task: "summarize",
			input: "Some input text to summarize.",
		});
		expect(result.text).toBe("A concise summary.");
		expect(result.data.summary).toBe("A concise summary.");
		expect(result.raw).toMatchObject({ provider: "gemini-acp" });
	});
});

describe.skipIf(enabled)("opt-in Gemini ACP smoke", () => {
	it("is skipped unless PI_GEMINI_ACP=1", () => {
		expect(process.env.PI_GEMINI_ACP).not.toBe("1");
	});
});

function fileReadConfig() {
	return {
		providers: {
			"gemini-acp": {
				enabled: true,
				command,
				args,
				authenticated: true,
				searchGroundingAvailable: true,
				permissionPolicy: { filesystemRead: true },
			},
		},
	};
}
