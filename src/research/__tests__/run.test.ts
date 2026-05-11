import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	GeminiAcpClient,
	GeminiAcpPromptRequest,
	GeminiAcpSearchRequest,
} from "../../acp/client.ts";
import type { ResearchSource, SearchResultItem } from "../../types.ts";
import { runResearch } from "../run.ts";

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

	it("uses provider-backed search dependencies for source collection", async () => {
		let factoryCalls = 0;
		const result = await runResearch(
			{ query: "alpha", rootDir, maxResults: 2 },
			{
				commandExists: async () => true,
				geminiAcpClientFactory: (settings) => {
					factoryCalls += 1;
					expect(settings.command).toBe("gemini");
					return new FakeGeminiClient();
				},
			},
		);

		expect(result.mode).toBe("gemini-acp");
		expect(result.provider).toBe("gemini-acp");
		expect(result.model).toBe("Gemini ACP default");
		expect(result.sources[0]?.title).toBe("Alpha result");
		expect(result.findings[0]?.text).toBe("alpha snippet");
		expect(factoryCalls).toBe(1);
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

	it("emits progress for research phases with request metadata", async () => {
		const updates: Array<{
			phase: string;
			message: string;
			query?: string;
			mode?: string;
			hydrateSources?: boolean;
		}> = [];
		await runResearch(
			{
				query: "alpha",
				rootDir,
				hydrateSources: true,
				sources: [
					{
						title: "Alpha",
						url: "https://example.com/a",
						text: "alpha source text",
					},
				],
			},
			{
				hydrator: {
					hydrate: async (source: ResearchSource) => source,
				},
				onProgress: (update) => {
					updates.push(update);
				},
			},
		);

		expect(updates.map((update) => update.phase)).toEqual([
			"search",
			"search",
			"hydrate",
			"hydrate",
			"assemble",
			"assemble",
			"store",
			"done",
		]);
		expect(updates[0]).toMatchObject({
			message: 'Using 1 supplied source(s) for research query: "alpha".',
			query: "alpha",
			mode: "local",
			hydrateSources: true,
			hydrationMode: "fetch",
			totalSources: 1,
		});
	});

	it("emits provider model in search collection progress", async () => {
		const updates: Array<{
			phase: string;
			message: string;
			provider?: string;
			model?: string;
			maxResults?: number;
		}> = [];
		await runResearch(
			{ query: "alpha", rootDir, maxResults: 2 },
			{
				commandExists: async () => true,
				geminiAcpClientFactory: () => new FakeGeminiClient(),
				onProgress: (update) => {
					updates.push(update);
				},
			},
		);

		expect(updates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					phase: "search",
					message: 'Sending search prompt: "alpha" with 2 max results via Gemini ACP default.',
					provider: "gemini-acp",
					model: "Gemini ACP default",
					maxResults: 2,
				}),
				expect.objectContaining({
					phase: "search",
					message: "Reusing warm search session for alpha.",
				}),
				expect.objectContaining({
					phase: "search",
					message: "● Waiting for Gemini backend...",
				}),
			]),
		);
	});

	it("adds provider citation markers without dropping structured citations", async () => {
		const result = await runResearch({
			query: "alpha",
			rootDir,
			sources: [
				{
					title: "Alpha",
					url: "https://example.com/a",
					text: "Alpha élan confirmed",
					providerMetadata: {
						grounding_metadata: {
							grounding_chunks: [{ web: { uri: "https://example.com/a", title: "Alpha" } }],
							grounding_supports: [
								{
									segment: {
										start_index: 0,
										end_index: Buffer.from("Alpha élan", "utf8").length,
										text: "Alpha élan",
									},
									grounding_chunk_indices: [0],
								},
							],
						},
					},
				},
			],
		});

		expect(result.findings[0]?.text).toBe("Alpha élan[1] confirmed");
		expect(result.citations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					marker: "[1]",
					providerSources: [expect.objectContaining({ url: "https://example.com/a" })],
				}),
				expect.objectContaining({
					sourceId: "s1",
					url: "https://example.com/a",
				}),
			]),
		);
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	async prompt(request: GeminiAcpPromptRequest): Promise<string> {
		return request.prompt;
	}

	async search(request: GeminiAcpSearchRequest): Promise<SearchResultItem[]> {
		request.onProgress?.("session", "Reusing warm search session for alpha.");
		request.onProgress?.("search", "● Waiting for Gemini backend...");
		return [
			{
				title: "Alpha result",
				url: "https://example.com/alpha",
				normalizedUrl: "https://example.com/alpha",
				snippet: "alpha snippet",
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
