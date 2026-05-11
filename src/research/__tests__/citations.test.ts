import { describe, expect, it } from "vitest";

import { insertProviderCitationMarkers, normalizeResearchProviderMetadata } from "../citations.js";

describe("research citation helpers", () => {
	it("inserts citation markers at multibyte byte offsets", () => {
		const text = "Alpha élan 🌍 confirmed";
		const metadata = normalizeResearchProviderMetadata({
			groundingMetadata: {
				groundingChunks: [{ web: { uri: "https://example.com/a" } }],
				groundingSupports: [
					{
						segment: {
							startIndex: 0,
							endIndex: Buffer.from("Alpha élan", "utf8").length,
							text: "Alpha élan",
						},
						groundingChunkIndices: [0],
					},
				],
			},
		});

		const result = insertProviderCitationMarkers(text, metadata);

		expect(result.text).toBe("Alpha élan[1] 🌍 confirmed");
		expect(result.citations[0]).toMatchObject({
			marker: "[1]",
			endByte: 11,
			providerSources: [{ url: "https://example.com/a" }],
		});
	});

	it("does not split a multibyte character when a provider offset is inside it", () => {
		const text = "Alpha élan 🌍 confirmed";
		const metadata = normalizeResearchProviderMetadata({
			grounding_metadata: {
				grounding_chunks: [{ web: { uri: "https://example.com/globe" } }],
				grounding_supports: [
					{
						segment: { start_index: 0, end_index: 14, text: "Alpha élan 🌍" },
						grounding_chunk_indices: [0],
					},
				],
			},
		});

		const result = insertProviderCitationMarkers(text, metadata);

		expect(result.text).toBe("Alpha élan 🌍[1] confirmed");
		expect(result.text).not.toContain("�");
	});

	it("normalizes camelCase provider metadata", () => {
		const metadata = normalizeResearchProviderMetadata({
			groundingMetadata: {
				groundingChunks: [{ web: { uri: "https://example.com/a", title: "Example A" } }],
				groundingSupports: [
					{
						segment: { startIndex: 1, endIndex: 7, text: "answer" },
						groundingChunkIndices: [0],
					},
				],
			},
			urlContextMetadata: {
				urlMetadata: [
					{
						retrievedUrl: "https://example.com/a",
						urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
					},
				],
			},
		});

		expect(metadata.groundingChunks[0]).toMatchObject({
			url: "https://example.com/a",
			title: "Example A",
			retrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
		});
		expect(metadata.groundingSupports[0]).toMatchObject({
			startByte: 1,
			endByte: 7,
			sourceIndexes: [0],
		});
	});

	it("normalizes snake_case provider metadata", () => {
		const metadata = normalizeResearchProviderMetadata({
			grounding_metadata: {
				grounding_chunks: [{ web: { uri: "https://example.com/b", title: "Example B" } }],
				grounding_supports: [
					{
						segment: { start_index: 2, end_index: 8, text: "answer" },
						grounding_chunk_indices: [0],
					},
				],
			},
			url_context_metadata: {
				url_metadata: [
					{
						retrieved_url: "https://example.com/b",
						url_retrieval_status: "URL_RETRIEVAL_STATUS_SUCCESS",
					},
				],
			},
		});

		expect(metadata.groundingChunks[0]).toMatchObject({
			url: "https://example.com/b",
			title: "Example B",
			retrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
		});
		expect(metadata.groundingSupports[0]).toMatchObject({
			startByte: 2,
			endByte: 8,
			sourceIndexes: [0],
		});
	});
});
