import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeminiAcpClient } from "../../acp/client.js";
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

	it("runs configured Gemini ACP through an injected client", async () => {
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
						},
					},
				},
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(),
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.results[0]?.source.provider).toBe("gemini-acp");
	});

	it("keeps missing Gemini config as a structured error", async () => {
		const result = await runSearch({ query: "x", rootDir, config: {} });
		expect(result.error?.code).toBe("GEMINI_ACP_MISSING_CONFIG");
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	async search(): Promise<SearchResultItem[]> {
		return [
			{
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
			},
		];
	}
}
