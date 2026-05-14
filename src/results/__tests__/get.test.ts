/** @file Route-level tests for progressive-disclosure stored-result retrieval. */
import { describe, expect, it, vi } from "vitest";

import { getStoredResult } from "../../storage/results.ts";
import { resultsGetRoute } from "../get.ts";
import type { StoredResultGetData } from "../shape-types.ts";

vi.mock("../../storage/results.ts");

function mockStored(value: unknown, path = "/tmp/test.json") {
	vi.mocked(getStoredResult).mockResolvedValue({
		responseId: "test-id",
		value,
		path,
	});
}

describe("resultsGetRoute.execute", () => {
	it("returns an overview for default view", async () => {
		mockStored({
			query: "q",
			summary: "s",
			sources: [{ id: "s1", title: "T", url: "https://example.com", text: "x" }],
			findings: [],
			citations: [],
		});
		const result = await resultsGetRoute.execute("x", { responseId: "test-id" });
		expect(result.content[0].text).toContain("Retrieved stored Gemini research result: test-id");
		expect(result.details.data).toMatchObject({ view: "overview", kind: "research" });
	});

	it("returns a bounded source page when view: source", async () => {
		mockStored({
			query: "q",
			summary: "s",
			sources: [{ id: "s1", title: "T", url: "https://example.com", text: "abc".repeat(900) }],
			findings: [],
			citations: [],
		});
		const result = await resultsGetRoute.execute("x", {
			responseId: "test-id",
			view: "source",
			sourceId: "s1",
			limit: 40,
		});
		expect(result.content[0].text).toContain("Retrieved stored source s1");
		const data = result.details.data as StoredResultGetData;
		expect(data).toMatchObject({ view: "source", source: { id: "s1" } });
		expect(data.view === "source" && data.pagination).toMatchObject({
			hasMore: true,
			start: 0,
			end: 40,
		});
	});

	it("returns a bounded raw JSON page when view: raw", async () => {
		mockStored({ text: "x".repeat(12_000) });
		const result = await resultsGetRoute.execute("x", {
			responseId: "test-id",
			view: "raw",
			limit: 100,
		});
		expect(result.content[0].text).toContain("Raw mode is diagnostic-heavy");
		const data = result.details.data as StoredResultGetData;
		expect(data).toMatchObject({ view: "raw", rawFormat: "json" });
		expect(data.view === "raw" && data.rawText).toHaveLength(100);
	});

	it("returns structured error for missing source", async () => {
		mockStored({
			summary: "s",
			sources: [{ id: "s1", text: "x" }],
			findings: [],
			citations: [],
		});
		const result = await resultsGetRoute.execute("x", {
			responseId: "test-id",
			view: "source",
			sourceId: "missing",
		});
		expect(result.details).toMatchObject({
			status: "error",
			error: { code: "RESULT_SOURCE_NOT_FOUND" },
		});
	});

	it("returns structured error for invalid cursor", async () => {
		mockStored({ text: "x".repeat(100) });
		const result = await resultsGetRoute.execute("x", {
			responseId: "test-id",
			view: "raw",
			cursor: "bad",
		});
		expect(result.details).toMatchObject({
			status: "error",
			error: { code: "RESULT_CURSOR_INVALID" },
		});
	});

	it("returns RESULT_NOT_FOUND when stored result does not exist", async () => {
		vi.mocked(getStoredResult).mockRejectedValue(new Error("not found"));
		const result = await resultsGetRoute.execute("x", { responseId: "missing-id" });
		expect(result.details).toMatchObject({
			status: "error",
			error: { code: "RESULT_NOT_FOUND", retryable: false },
		});
	});
});
