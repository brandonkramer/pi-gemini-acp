import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createGeminiSummarizeAdapter } from "../../adapter/gemini-summarize.ts";
import { runFileAnalyze } from "../../prompt/file-analyze.ts";
import { runImageDescribe, type ImageDescribeResult } from "../../prompt/image-describe.ts";
import { runSearch } from "../../search/run.ts";
import { StdioGeminiAcpClient } from "../client.ts";

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

	// With filesystemWrite allowed,, every edit used to fail with "Method not found:
	// fs/write_text_file" because the client advertised a handler it did not implement.
	it("lets Gemini edit a file when the policy allows writes", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-gemini-smoke-edit-"));
		const trace = path.join(cwd, "trace.jsonl");
		const previousTrace = process.env.PI_GEMINI_ACP_TRACE_FILE;
		process.env.PI_GEMINI_ACP_TRACE_FILE = trace;
		try {
			await writeFile(path.join(cwd, "a.txt"), "one\ntwo\n", "utf8");
			const client = new StdioGeminiAcpClient({
				command,
				args: args.includes("--skip-trust") ? args : [...args, "--skip-trust"],
				permissionPolicy: { filesystemRead: true, filesystemWrite: true, terminal: false },
			});
			await client.prompt({
				prompt:
					"Use your file-editing tool, not a shell command, to append exactly one line containing three to a.txt. Then reply with done.",
				cwd,
			});
			expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toMatch(/^one\ntwo\nthree\n?$/u);
			expect(await readFile(trace, "utf8")).not.toContain('"code":-32601');
		} finally {
			if (previousTrace === undefined) delete process.env.PI_GEMINI_ACP_TRACE_FILE;
			else process.env.PI_GEMINI_ACP_TRACE_FILE = previousTrace;
			await rm(cwd, { recursive: true, force: true });
		}
	}, 180_000);

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
			expect(result.image?.kind).toBe("path");
			expectImageDescribeSuccess(result);
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

function expectImageDescribeSuccess(result: ImageDescribeResult) {
	if (result.error?.code === "GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED") return;
	expect(result.error).toBeUndefined();
	expect(result.caption?.length).toBeGreaterThan(0);
}
