/**
 * @fileoverview Smoke coverage for the registered Gemini tool surface.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ExtractRunResult } from "../../prompt/extract.js";
import type {
	PiToolShell,
	ResearchResult,
	ResultEnvelope,
} from "../../types.js";
import { formatExtractToolText } from "../../ask/extract.js";
import { formatResearchToolText } from "../gemini-research.js";
import { geminiAcpTools } from "../register.js";
import { toolResult } from "../result.js";

describe("gemini ACP tools smoke", () => {
	it("registers the standalone tool surface", () => {
		expect(geminiAcpTools.map((tool) => tool.name)).toEqual([
			"gemini_status",
			"gemini_ask",
			"gemini_search",
			"gemini_research",
			"gemini_analyze",
			"gemini_results",
		]);
	});

	it("gemini_status output includes modelAdapter field with expected shape", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_status",
		);
		const result = await tool?.execute(
			"x",
			{} as never,
			new AbortController().signal,
		);
		assertShell(result);
		const data = (result.details as ResultEnvelope<unknown>).data as {
			modelAdapter: {
				offered: boolean;
				capabilities: string[];
				priority: number;
			};
		};
		expect(data.modelAdapter).toBeDefined();
		expect(typeof data.modelAdapter.offered).toBe("boolean");
		expect(Array.isArray(data.modelAdapter.capabilities)).toBe(true);
		expect(typeof data.modelAdapter.priority).toBe("number");
	});

	it("returns Pi shell with visible data and progress for local search", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_search",
		);
		const updates: PiToolShell[] = [];
		const result = await tool?.execute(
			"x",
			{
				query: "alpha",
				localDocuments: [
					{ title: "Alpha", url: "https://example.com/", text: "alpha text" },
				],
			} as never,
			new AbortController().signal,
			(update) => {
				updates.push(update);
			},
		);
		assertShell(result);
		expect(result.content[0]?.text).toContain("1 result");
		expect(result.content[0]?.text).toContain("https://example.com/");
		expect(result.content[0]?.text).not.toContain("Search result data JSON");
		expect(
			(result.details as ResultEnvelope<{ results: unknown[] }>).data.results,
		).toHaveLength(1);
		const collapsed = tool?.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const expanded = tool?.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		expect(collapsed?.render(120).join("\n")).toContain("Press Ctrl+O");
		expect(collapsed?.render(120).join("\n")).not.toContain("Top result");
		expect(expanded?.render(120).join("\n")).toContain("provider: local");
		expect(expanded?.render(120).join("\n")).toContain("Alpha");
		const phases = updates.map(
			(update) =>
				(update.details as ResultEnvelope<{ progress: { phase: string } }>).data
					.progress.phase,
		);
		expect(phases).toEqual(
			expect.arrayContaining(["local_search", "store_results", "complete"]),
		);
	});

	it("renders search call title through the shared renderer lifecycle", () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_search",
		);
		const state: Record<string, unknown> = {};
		const partial = tool?.renderCall?.({} as never, undefined, {
			expanded: false,
			isPartial: true,
			state,
			invalidate: () => undefined,
		});
		expect(partial?.render(120).join("\n")).toContain("gemini_search");
		expect(state.geminiSearchTitle).toBeTruthy();

		const done = tool?.renderCall?.({} as never, undefined, {
			expanded: false,
			isPartial: false,
			lastComponent: partial,
			state,
		});
		expect(done?.render(120).join("\n")).toContain("gemini_search");
		expect(state.geminiSearchTitle).toBeUndefined();
	});

	it("formats extract results with visible JSON for assistant follow-up", () => {
		const result = {
			provider: "gemini-acp",
			extracted: {
				title: "example glossary",
				entry: { id: "SGML", seeAlso: ["GML", "XML"] },
			},
			rawText: "{}",
			responseLength: 2,
			truncated: false,
			responseId: "abc123",
			fullOutputPath: "/tmp/extract.json",
		} satisfies ExtractRunResult;

		const text = formatExtractToolText(result);

		expect(text).toContain("Gemini ACP extract returned JSON");
		expect(text).toContain("Extracted JSON:");
		expect(text).toContain('"title": "example glossary"');
		expect(text).toContain('"seeAlso": [');
		expect(text).toContain("responseId abc123");
		expect(text).toContain("/tmp/extract.json");
	});

	it("formats research results as useful assistant-facing summaries", () => {
		const result = {
			query: "different domestic cat types",
			summary: "Research collected 2 sources.",
			mode: "gemini-acp",
			provider: "gemini-acp",
			model: "gemini-3-flash-preview",
			sources: [
				{
					id: "s1",
					title: "Maine Coon traits",
					url: "https://example.com/maine-coon",
					normalizedUrl: "https://example.com/maine-coon",
					snippet: "Large, shaggy, sociable cats with tufted ears.",
					provider: "gemini-acp",
				},
				{
					id: "s2",
					title: "Siamese traits",
					url: "https://example.com/siamese",
					normalizedUrl: "https://example.com/siamese",
					snippet: "Vocal, social cats with point coloration and blue eyes.",
					provider: "gemini-acp",
				},
			],
			findings: [],
			citations: [
				{ sourceId: "s1", url: "https://example.com/maine-coon" },
				{ sourceId: "s2", url: "https://example.com/siamese" },
			],
			responseId: "research123",
		} satisfies ResearchResult;

		const text = formatResearchToolText(result);

		expect(text).toContain("Gemini research summary:");
		expect(text).toContain("Researched: different domestic cat types");
		expect(text).toContain("Used: gemini-acp via gemini-3-flash-preview.");
		expect(text).toContain("Collected source notes:");
		expect(text).toContain("Maine Coon traits");
		expect(text).toContain("Siamese traits");
		expect(text).toContain("Assistant response guidance:");
		expect(text).toContain("responseId: research123");
	});

	it("renders prompt-style output collapsed and expanded without changing content", () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_ask",
		);
		const text = `${"alpha response ".repeat(30)}done`;
		const result = toolResult({
			text: `Gemini ACP response:\n${text}`,
			data: {
				provider: "gemini-acp",
				text,
				responseLength: text.length,
				truncated: false,
			},
		});
		expect(result.content[0]?.text).toContain(text);

		const collapsed = tool?.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const expanded = tool?.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		expect(collapsed?.render(120).join("\n")).toContain("Press Ctrl+O");
		expect(collapsed?.render(120).join("\n")).toContain("Preview:");
		const expandedText = expanded?.render(120).join("\n");
		expect(expandedText).toContain("provider: gemini-acp");
		expect(expandedText).toContain("alpha response");
		expect(expandedText).toContain("done");
	});

	it("renders prompt-style streaming progress in collapsed and expanded modes", () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_ask",
		);
		const update = toolResult({
			text: "stream chunk",
			status: "streaming",
			data: {
				type: "chunk",
				text: "stream chunk",
				accumulatedText: "first stream chunk",
			},
		});
		const collapsed = tool?.renderResult?.(
			update,
			{ expanded: false, isPartial: true },
			undefined,
			{ expanded: false, isPartial: true },
		);
		const expanded = tool?.renderResult?.(
			update,
			{ expanded: true, isPartial: true },
			undefined,
			{ expanded: true, isPartial: true },
		);
		expect(collapsed?.render(120).join("\n")).toContain(
			"Receiving: stream chunk",
		);
		expect(expanded?.render(120).join("\n")).toContain("accumulated preview:");
		expect(expanded?.render(120).join("\n")).toContain("first stream chunk");
	});

	it("renders code review findings concisely until expanded", () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_ask",
		);
		const reviewText = [
			"## Blockers",
			"- [blocker] Crash on empty input — evidence; impact; recommendation.",
			"## Important",
			"- [important] Missing validation — evidence; impact; recommendation.",
			"## Optional",
			"None found.",
			"## Validation",
			"Run npm test.",
		].join("\n");
		const result: PiToolShell = {
			content: [
				{
					type: "text",
					text: `Gemini ACP code review (analysis only):\n${reviewText}`,
				},
			],
			details: {
				timing: { startedAt: "now" },
				data: {
					provider: "gemini-acp",
					text: reviewText,
					responseLength: reviewText.length,
					truncated: false,
					sections: ["Blockers", "Important", "Optional", "Validation"],
				},
			} satisfies Partial<ResultEnvelope<unknown>>,
		};

		const collapsed = tool?.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const expanded = tool?.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		expect(collapsed?.render(120).join("\n")).toContain("2 finding");
		expect(collapsed?.render(120).join("\n")).toContain("Press Ctrl+O");
		expect(collapsed?.render(120).join("\n")).not.toContain(
			"Crash on empty input",
		);
		expect(expanded?.render(120).join("\n")).toContain("Crash on empty input");
		expect(expanded?.render(120).join("\n")).toContain("responseLength:");
	});

	it("renders translation previews and structured progress metadata", () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_ask",
		);
		const translation = `${"hola ".repeat(60)}fin`;
		const result: PiToolShell = {
			content: [
				{
					type: "text",
					text: `Gemini ACP translation to Spanish:\n${translation}`,
				},
			],
			details: {
				timing: { startedAt: "now" },
				data: {
					provider: "gemini-acp",
					mode: "single",
					targetLanguage: "Spanish",
					itemCount: 1,
					text: translation,
					responseLength: translation.length,
					truncated: false,
				},
			} satisfies Partial<ResultEnvelope<unknown>>,
		};
		const progress: PiToolShell = {
			content: [{ type: "text", text: "hola" }],
			details: {
				status: "streaming",
				timing: { startedAt: "now" },
				data: {
					progress: { type: "chunk", text: "hola", accumulatedText: "hola" },
				},
			} satisfies Partial<ResultEnvelope<unknown>>,
		};

		const collapsed = tool?.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const expanded = tool?.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		const progressCollapsed = tool?.renderResult?.(
			progress,
			{ expanded: false, isPartial: true },
			undefined,
			{ expanded: false, isPartial: true },
		);
		expect(collapsed?.render(120).join("\n")).toContain("Press Ctrl+O");
		expect(collapsed?.render(120).join("\n").length).toBeLessThan(
			expanded?.render(120).join("\n").length ?? 0,
		);
		expect(expanded?.render(120).join("\n")).toContain(
			"targetLanguage: Spanish",
		);
		expect(progressCollapsed?.render(120).join("\n")).toContain("hola");
		expect(
			(progress.details as ResultEnvelope<{ progress: { type: string } }>).data
				.progress.type,
		).toBe("chunk");
	});

	it("returns Pi shell for file analysis validation errors", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_analyze",
		);
		const progress: PiToolShell[] = [];
		const result = await tool?.execute(
			"x",
			{
				kind: "file",
				paths: [".env"],
				instructions: "Summarize this file.",
			} as never,
			new AbortController().signal,
			(update) => {
				progress.push(update);
			},
		);
		assertShell(result);
		expect(result?.content[0]?.text).toContain(
			"Hidden files or directories are rejected",
		);
		expect(result?.details).toMatchObject({
			status: "error",
			error: { code: "GEMINI_FILE_ANALYZE_HIDDEN_PATH_REJECTED" },
		});
		expect(progress[0]?.content[0]?.text).toContain(".env");
		expect(progress[0]?.content[0]?.text).toContain("Instructions length");
	});

	it("returns explicit base64-unsupported shell for image description", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_analyze",
		);
		const result = await tool?.execute(
			"x",
			{
				imageDataBase64: Buffer.from([
					0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
				]).toString("base64"),
				mimeType: "image/png",
			} as never,
			new AbortController().signal,
		);
		assertShell(result);
		expect(result?.details).toMatchObject({
			status: "error",
			error: { code: "GEMINI_ACP_IMAGE_BASE64_UNSUPPORTED" },
		});
	});

	it("renders local research progress and collapsed/expanded results", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_research",
		);
		const updates: PiToolShell[] = [];
		const result = await tool?.execute(
			"x",
			{
				query: "alpha",
				sources: [
					{ title: "Alpha", url: "https://example.com/", text: "alpha text" },
				],
			} as never,
			new AbortController().signal,
			(update) => {
				updates.push(update);
			},
		);
		assertShell(result);
		expect(result.content[0]?.text).toContain("responseId:");
		expect(result.details).toMatchObject({ responseId: expect.any(String) });
		expect(updates.length).toBeGreaterThan(0);
		expect(updates[0]?.details).toMatchObject({
			status: "progress",
			data: { progress: { phase: "search" } },
		});

		const collapsedProgress = tool?.renderResult?.(
			updates[0] as PiToolShell,
			{ expanded: false, isPartial: true },
			undefined,
			{ expanded: false, isPartial: true },
		);
		const expandedProgress = tool?.renderResult?.(
			updates[0] as PiToolShell,
			{ expanded: true, isPartial: true },
			undefined,
			{ expanded: true, isPartial: true },
		);
		expect(collapsedProgress?.render(120).join("\n")).toContain(
			"Collecting sources",
		);
		expect(expandedProgress?.render(120).join("\n")).toContain(
			"gemini_research search",
		);

		const collapsed = tool?.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const expanded = tool?.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		const collapsedText = collapsed?.render(120).join("\n");
		const expandedText = expanded?.render(120).join("\n");
		expect(collapsedText).toContain("sources: 1; findings: 1; citations: 1");
		expect(collapsedText).toContain("Press Ctrl+O");
		expect(collapsedText).not.toContain("fullOutputPath:");
		expect(expandedText).toContain("fullOutputPath:");
		expect(expandedText).toContain("Sources:");
		expect(expandedText).toContain("Findings:");
		expect(expandedText).toContain("Citations:");
	});
});

function assertShell(
	result: PiToolShell | undefined,
): asserts result is PiToolShell {
	expect(result?.content[0]?.type).toBe("text");
	expect(result?.details).toBeTruthy();
}
