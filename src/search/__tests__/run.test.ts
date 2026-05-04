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
import { saveGeminiAcpSettings } from "../../config/settings.js";
import type { SearchResultItem } from "../../types.js";
import { __resetGeminiSearchPreflightCache, runSearch } from "../run.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-search-"));
});

afterEach(async () => {
	__resetGeminiSearchPreflightCache();
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
				maxResults: 7,
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
					phase: "provider_search",
					provider: "gemini-acp",
					model: "gemini-test",
					query: "weather",
					maxResults: 7,
					message:
						'Sending search prompt: "weather" with 7 max results via gemini-test.',
				}),
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

	it("caches successful provider preflight for warm search calls", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: false,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);
		let commandChecks = 0;
		let authProbes = 0;
		const deps = {
			commandExists: async () => {
				commandChecks += 1;
				return true;
			},
			authProbe: async () => {
				authProbes += 1;
				return { authenticated: true };
			},
			geminiAcpClient: new FakeGeminiClient(),
		};

		await runSearch({ query: "one", rootDir }, deps);
		await runSearch({ query: "two", rootDir }, deps);

		expect(commandChecks).toBe(1);
		expect(authProbes).toBe(1);
	});

	it("invalidates cached preflight after auth-shaped search failures", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: true,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);
		let commandChecks = 0;
		const client = new AuthFailureThenSuccessClient();
		const deps = {
			commandExists: async () => {
				commandChecks += 1;
				return true;
			},
			geminiAcpClient: client,
		};

		expect(
			(await runSearch({ query: "one", rootDir }, deps)).error,
		).toBeUndefined();
		expect((await runSearch({ query: "two", rootDir }, deps)).error?.code).toBe(
			"GEMINI_ACP_FAILED",
		);
		expect(
			(await runSearch({ query: "three", rootDir }, deps)).error,
		).toBeUndefined();

		expect(commandChecks).toBe(2);
	});

	it("bypasses process preflight cache for caller-supplied config", async () => {
		let commandChecks = 0;
		let authProbes = 0;
		const config = {
			providers: {
				"gemini-acp": {
					enabled: true,
					command: "gemini",
					authenticated: false,
					searchGroundingAvailable: true,
				},
			},
		};
		const deps = {
			commandExists: async () => {
				commandChecks += 1;
				return true;
			},
			authProbe: async () => {
				authProbes += 1;
				return { authenticated: true };
			},
			geminiAcpClient: new FakeGeminiClient(),
		};

		await runSearch({ query: "one", rootDir, config }, deps);
		await runSearch({ query: "two", rootDir, config }, deps);

		expect(commandChecks).toBe(2);
		expect(authProbes).toBe(2);
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

class AuthFailureThenSuccessClient implements GeminiAcpClient {
	private calls = 0;

	async prompt(request: GeminiAcpPromptRequest): Promise<string> {
		return request.prompt;
	}

	async search(): Promise<SearchResultItem[]> {
		this.calls += 1;
		if (this.calls === 2) {
			const error = new Error("Gemini ACP auth expired") as Error & {
				code: string;
			};
			error.code = "GEMINI_ACP_UNAUTHENTICATED";
			throw error;
		}
		return [searchResult()];
	}
}

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
