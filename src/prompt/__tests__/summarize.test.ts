import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	GeminiAcpClient,
	GeminiAcpPromptRequest,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpSearchRequest,
} from "../../acp/client.js";
import { getStoredResult } from "../../storage/results.js";
import type { SearchResultItem } from "../../types.js";
import { runSummarize } from "../summarize.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-summarize-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runSummarize", () => {
	it("summarizes provided content through an injected Gemini ACP client", async () => {
		const client = new FakeGeminiClient(["Two bullet summary"]);
		const result = await runSummarize(
			{
				content: "Alpha is the first topic. Beta is the second topic.",
				bulletCount: 2,
				rootDir,
				config: {},
			},
			{ commandExists: async () => true, geminiAcpClient: client },
		);

		expect(result.error).toBeUndefined();
		expect(result.summary).toBe("Two bullet summary");
		expect(result.source.kind).toBe("content");
		expect(result.source.truncated).toBe(false);
		expect(client.promptText).toContain("Use exactly 2 concise bullet(s).");
		expect(client.promptText).toContain("Alpha is the first topic.");
	});

	it("emits preparation, prompt, streaming, and store progress updates", async () => {
		const updates: Array<{ phase?: string; type: string; text: string }> = [];
		const result = await runSummarize(
			{
				content: "x".repeat(1500),
				maxSourceCharacters: 1000,
				rootDir,
				config: {},
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(["Short", " summary"]),
			},
			undefined,
			async (update) => {
				updates.push({
					type: update.type,
					phase: update.type === "progress" ? update.phase : undefined,
					text: update.text,
				});
			},
		);

		expect(result.summary).toBe("Short summary");
		expect(result.source.truncated).toBe(true);
		expect(result.responseId).toBeTruthy();
		expect(updates.map((update) => update.phase)).toEqual([
			"source_prepare",
			"source_prepare",
			"provider_preflight",
			"provider_prompt",
			undefined,
			undefined,
			"store",
		]);
		expect(updates[1]?.text).toContain("Source truncated from 1500 to 1000");
		const stored = await getStoredResult<{
			preparedSource: string;
			summary: string;
		}>(result.responseId ?? "", { rootDir });
		expect(stored.value.preparedSource).toHaveLength(1000);
		expect(stored.value.summary).toBe("Short summary");
	});

	it("fetches one safe URL directly and passes the abort signal", async () => {
		const client = new FakeGeminiClient(["Fetched summary"]);
		let fetchedUrl = "";
		let fetchedSignal: AbortSignal | undefined;
		const controller = new AbortController();
		const result = await runSummarize(
			{ url: "https://example.com/page", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: client,
				fetch: (async (url, init) => {
					fetchedUrl = String(url);
					fetchedSignal = init?.signal ?? undefined;
					return response("<h1>Title</h1><script>bad()</script><p>Body</p>");
				}) as typeof fetch,
			},
			controller.signal,
		);

		expect(result.error).toBeUndefined();
		expect(result.source).toMatchObject({
			kind: "url",
			url: "https://example.com/page",
		});
		expect(fetchedUrl).toBe("https://example.com/page");
		expect(fetchedSignal).toBe(controller.signal);
		expect(client.promptText).toContain("Title Body");
		expect(client.promptText).not.toContain("bad()");
	});

	it("rejects private URL summarization before fetch", async () => {
		let fetchCalls = 0;
		const result = await runSummarize(
			{ url: "http://localhost/private", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(["nope"]),
				fetch: (async () => {
					fetchCalls += 1;
					return response("nope");
				}) as typeof fetch,
			},
		);

		expect(result.error?.code).toBe("GEMINI_SUMMARIZE_SOURCE_UNSAFE");
		expect(fetchCalls).toBe(0);
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	promptText = "";

	constructor(private readonly chunks: string[]) {}

	async search(_request: GeminiAcpSearchRequest): Promise<SearchResultItem[]> {
		return [];
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		_signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		this.promptText = request.prompt;
		let accumulatedText = "";
		for (const text of this.chunks) {
			accumulatedText += text;
			await onUpdate?.({ type: "chunk", text, accumulatedText });
		}
		return accumulatedText;
	}
}

function response(text: string): Response {
	return {
		ok: true,
		status: 200,
		text: async () => text,
	} as Response;
}
