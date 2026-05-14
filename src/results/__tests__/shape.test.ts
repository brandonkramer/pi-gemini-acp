/** @file Tests progressive-disclosure shaping for stored Gemini results. */
import { describe, expect, it } from "vitest";

import type { PageResult } from "../pagination.ts";
import {
	formatStoredResultText,
	shapeStoredResultOverview,
	shapeStoredResultRaw,
	shapeStoredResultSource,
} from "../shape.ts";

function ok<T>(result: PageResult<T>): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function errorCode<T>(result: PageResult<T>): string {
	if (result.ok) throw new Error("Expected error result.");
	return result.error.code;
}

describe("stored-result shaping", () => {
	it("builds an agent-friendly research overview with source notes", () => {
		const overview = ok(
			shapeStoredResultOverview({
				responseId: "r1",
				fullOutputPath: "/tmp/r1.json",
				value: {
					query: "best observability docs",
					summary: "Research collected two observability sources.",
					sources: [
						{
							id: "docs",
							title: "Observability Guide",
							url: "https://example.com/observability",
							text: "Metrics, traces, and logs are the three pillars used by this guide.",
						},
						{
							id: "s2",
							title: "Tracing Notes",
							url: "https://example.com/tracing",
							snippet: "Tracing connects spans across services.",
						},
					],
					findings: [{ sourceId: "docs", text: "Use metrics, traces, and logs together." }],
					citations: [{ sourceId: "docs", marker: "[1]", text: "Metrics and traces." }],
				},
			}),
		);

		expect(overview.kind).toBe("research");
		expect(overview.query).toBe("best observability docs");
		expect(overview.sourceNotes[0]?.id).toBe("docs");
		expect(overview.nextActions[0]?.params).toMatchObject({ view: "source", sourceId: "docs" });
		expect(overview.diagnostics.fullOutputPath).toBe("/tmp/r1.json");
		expect(formatStoredResultText(overview)).toContain("Key findings:");
		expect(formatStoredResultText(overview)).toContain("Top sources:");
	});

	it("builds a search overview with stable source ids and top-n quality", () => {
		const overview = ok(
			shapeStoredResultOverview({
				responseId: "search1",
				value: {
					provider: "gemini-acp",
					results: [
						{
							title: "Alpha",
							url: "https://example.com/a",
							normalizedUrl: "https://example.com/a",
							snippet: "Alpha snippet",
							ranking: 1,
							source: { provider: "gemini-acp" },
						},
					],
				},
			}),
		);

		expect(overview.kind).toBe("search");
		expect(overview.sourceNotes).toHaveLength(1);
		expect(overview.sourceNotes[0]?.id).toBe("s1");
		expect(overview.qualitySignals.coverage).toBe("top_n_only");
		expect(overview.answerContext).toContain("Alpha snippet");
	});

	it("shapes unknown payloads without crashing", () => {
		const overview = ok(
			shapeStoredResultOverview({
				responseId: "unknown1",
				value: { arbitrary: { nested: true }, count: 2 },
			}),
		);

		expect(overview.kind).toBe("unknown");
		expect(overview.summary).toContain("arbitrary");
		expect(overview.sourceNotes).toEqual([]);
	});

	it("inspects a bounded source text page with an opaque continuation cursor", () => {
		const longText = `${"alpha ".repeat(800)}omega`;
		const firstPage = ok(
			shapeStoredResultSource(
				{
					responseId: "r2",
					value: {
						summary: "Long source research.",
						sources: [{ id: "s1", title: "Long", url: "https://example.com/long", text: longText }],
						findings: [],
						citations: [],
					},
				},
				{ sourceId: "s1", limit: 40 },
			),
		);
		const secondPage = ok(
			shapeStoredResultSource(
				{
					responseId: "r2",
					value: {
						summary: "Long source research.",
						sources: [{ id: "s1", title: "Long", url: "https://example.com/long", text: longText }],
						findings: [],
						citations: [],
					},
				},
				{ sourceId: "s1", limit: 40, cursor: firstPage.pagination.nextCursor },
			),
		);

		expect(firstPage.sourceText).toHaveLength(40);
		expect(firstPage.pagination.hasMore).toBe(true);
		expect(firstPage.pagination.nextCursor).toBeTruthy();
		expect(secondPage.pagination.start).toBe(40);
		expect(secondPage.sourceText).not.toBe(firstPage.sourceText);
	});

	it("returns structured errors for missing sources and invalid cursors", () => {
		const context = {
			responseId: "r3",
			value: { summary: "No sources.", sources: [], findings: [], citations: [] },
		};

		expect(errorCode(shapeStoredResultSource(context, { sourceId: "missing" }))).toBe(
			"RESULT_SOURCE_NOT_FOUND",
		);
		expect(
			errorCode(
				shapeStoredResultSource(
					{
						responseId: "r4",
						value: {
							summary: "One source.",
							sources: [{ id: "s1", text: "available text" }],
							findings: [],
							citations: [],
						},
					},
					{ sourceId: "s1", cursor: "bad" },
				),
			),
		).toBe("RESULT_CURSOR_INVALID");
		expect(errorCode(shapeStoredResultRaw(context, { cursor: "bad" }))).toBe(
			"RESULT_CURSOR_INVALID",
		);
	});

	it("returns bounded raw JSON pages", () => {
		const raw = ok(
			shapeStoredResultRaw(
				{
					responseId: "raw1",
					value: { text: "x".repeat(10_000) },
				},
				{ limit: 100 },
			),
		);

		expect(raw.rawText.length).toBe(100);
		expect(raw.pagination.hasMore).toBe(true);
		expect(raw.nextActions[0]?.params).toMatchObject({ view: "raw" });
		expect(formatStoredResultText(raw)).toContain("Raw mode is diagnostic-heavy");
	});
});
