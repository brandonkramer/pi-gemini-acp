import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	GeminiAcpClient,
	GeminiAcpPromptRequest,
} from "../../acp/client.js";
import type { ResearchSource, SearchResultItem } from "../../types.js";
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

	it("emits progress for research phases", async () => {
		const phases: string[] = [];
		await runResearch(
			{
				query: "alpha",
				rootDir,
				sources: [
					{
						title: "Alpha",
						url: "https://example.com/a",
						text: "alpha source text",
					},
				],
			},
			{
				onProgress: (update) => {
					phases.push(update.phase);
				},
			},
		);

		expect(phases).toEqual([
			"search",
			"search",
			"hydrate",
			"assemble",
			"store",
			"done",
		]);
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
							grounding_chunks: [
								{ web: { uri: "https://example.com/a", title: "Alpha" } },
							],
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
					providerSources: [
						expect.objectContaining({ url: "https://example.com/a" }),
					],
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

	async search(): Promise<SearchResultItem[]> {
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
