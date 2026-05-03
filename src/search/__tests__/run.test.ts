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
import type { SearchResultItem } from "../../types.js";
import { runSearch } from "../run.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-search-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runSearch", () => {
	it("runs local/no-key search over supplied documents", async () => {
		const result = await runSearch({
			query: "scraper",
			rootDir,
			localDocuments: [
				{
					title: "Pi Scraper",
					url: "https://example.com/?utm_source=x",
					text: "local scraper text",
				},
			],
		});
		expect(result.provider).toBe("local");
		expect(result.results[0]?.normalizedUrl).toBe("https://example.com/");
		expect(result.responseId).toBeTruthy();
	});

	it("runs default Gemini ACP config through an injected client", async () => {
		const result = await runSearch(
			{
				query: "x",
				rootDir,
				config: {},
			},
			{
				commandExists: async (command) => command === "gemini",
				geminiAcpClient: new FakeGeminiClient(),
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.results[0]?.source.provider).toBe("gemini-acp");
	});

	it("emits provider stream progress with chunk and model metadata", async () => {
		const updates: unknown[] = [];
		const result = await runSearch(
			{
				query: "weather",
				rootDir,
				config: {
					providers: {
						"gemini-acp": {
							enabled: true,
							command: "gemini",
							args: ["--acp", "--model", "gemini-test"],
							authenticated: true,
							searchGroundingAvailable: true,
						},
					},
				},
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new StreamingFakeGeminiClient(),
				onProgress: (update) => {
					updates.push(update);
				},
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.model).toBe("gemini-test");
		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					phase: "provider_stream",
					provider: "gemini-acp",
					model: "gemini-test",
					query: "weather",
					chunk: expect.objectContaining({
						type: "chunk",
						text: "streamed search chunk",
						accumulatedText: "streamed search chunk",
					}),
				}),
			]),
		);
	});

	it("uses the default Gemini ACP client factory when no client is injected", async () => {
		let factoryCalls = 0;
		const result = await runSearch(
			{
				query: "x",
				rootDir,
				config: {
					providers: {
						"gemini-acp": {
							enabled: true,
							command: "custom-gemini",
							args: ["--acp"],
							authenticated: true,
							searchGroundingAvailable: true,
						},
					},
				},
			},
			{
				commandExists: async () => true,
				geminiAcpClientFactory: (settings) => {
					factoryCalls += 1;
					expect(settings.command).toBe("custom-gemini");
					return new FakeGeminiClient();
				},
			},
		);

		expect(result.error).toBeUndefined();
		expect(factoryCalls).toBe(1);
	});

	it("reports a missing default Gemini command as a structured error", async () => {
		const result = await runSearch(
			{ query: "x", rootDir, config: {} },
			{ commandExists: async () => false },
		);
		expect(result.error?.code).toBe("GEMINI_ACP_COMMAND_NOT_FOUND");
	});

	it("refuses a selected model until model support is confirmed", async () => {
		const result = await runSearch(
			{
				query: "x",
				rootDir,
				config: {
					providers: {
						"gemini-acp": {
							enabled: true,
							command: "gemini",
							authenticated: true,
							searchGroundingAvailable: true,
							model: "gemini-2.5-pro",
						},
					},
				},
			},
			{ commandExists: async () => true },
		);

		expect(result.error?.code).toBe("GEMINI_ACP_MODEL_SELECTION_UNCONFIRMED");
	});
});

class StreamingFakeGeminiClient implements GeminiAcpClient {
	async prompt(request: GeminiAcpPromptRequest): Promise<string> {
		return request.prompt;
	}

	async search(
		_request: GeminiAcpSearchRequest,
		_signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<SearchResultItem[]> {
		await onUpdate?.({
			type: "chunk",
			text: "streamed search chunk",
			accumulatedText: "streamed search chunk",
		});
		return [searchResult()];
	}
}

class FakeGeminiClient implements GeminiAcpClient {
	async prompt(request: GeminiAcpPromptRequest): Promise<string> {
		return request.prompt;
	}

	async search(): Promise<SearchResultItem[]> {
		return [searchResult()];
	}
}

function searchResult(): SearchResultItem {
	return {
		title: "Gemini",
		url: "https://example.com/g",
		normalizedUrl: "https://example.com/g",
		snippet: "g",
		ranking: 1,
		source: {
			provider: "gemini-acp",
			kind: "gemini-acp",
			requiresCloud: false,
			requiresApiKey: false,
			requiresLocalAuth: true,
		},
	};
}
