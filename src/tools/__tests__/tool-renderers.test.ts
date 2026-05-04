import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { PiToolShell } from "../../types.js";
import { geminiAcpTools } from "../register.js";
import { toolResult } from "../result.js";

const rendered = (component: { render(width: number): string[] } | undefined) =>
	component?.render(120).join("\n") ?? "";

describe("Gemini tool renderers", () => {
	it("exposes custom collapsed/expanded renderers for every Gemini tool", () => {
		for (const name of [
			"gemini_status",
			"gemini_prompt",
			"gemini_extract",
			"gemini_summarize",
			"gemini_search",
			"gemini_research",
			"gemini_file_analyze",
			"gemini_code_review",
			"gemini_translate",
			"gemini_image_describe",
			"gemini_recall",
			"gemini_get_result",
		] as const) {
			const tool = geminiAcpTools.find((candidate) => candidate.name === name);
			expect(tool?.renderCall).toBeTypeOf("function");
			expect(tool?.renderResult).toBeTypeOf("function");
		}
	});

	it("renders file analysis validation errors with expansion details", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_file_analyze",
		);
		const result = await tool?.execute(
			"x",
			{ paths: [".env"], instructions: "Summarize this file." } as never,
			new AbortController().signal,
		);
		expect(result).toBeDefined();
		const collapsed = tool?.renderResult?.(
			result!,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const expanded = tool?.renderResult?.(
			result!,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		expect(rendered(collapsed)).toContain("Press Ctrl+O");
		expect(rendered(expanded)).toContain(
			"GEMINI_FILE_ANALYZE_HIDDEN_PATH_REJECTED",
		);
	});

	it("renders image validation results with expansion details", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_image_describe",
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
		expect(result).toBeDefined();
		const collapsed = tool?.renderResult?.(
			result!,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const expanded = tool?.renderResult?.(
			result!,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		expect(rendered(collapsed)).toContain("Press Ctrl+O");
		expect(rendered(expanded)).toContain("image.mimeType");
	});

	it("renders status and get-result with shared collapsed and expanded UX", async () => {
		const statusTool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_status",
		);
		const statusResult = await statusTool?.execute(
			"x",
			{} as never,
			new AbortController().signal,
		);
		expect(statusResult).toBeDefined();
		const statusCollapsed = statusTool?.renderResult?.(
			statusResult!,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const statusExpanded = statusTool?.renderResult?.(
			statusResult!,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		expect(rendered(statusCollapsed)).toContain("Press Ctrl+O");
		expect(rendered(statusExpanded)).toContain("File analysis capability");

		const getResultTool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_get_result",
		);
		const getResultShell: PiToolShell = toolResult({
			text: "Retrieved result abc123.",
			data: { query: "alpha", sources: [{ url: "https://example.com" }] },
			responseId: "abc123",
			fullOutputPath: "/tmp/abc123.json",
		});
		const getCollapsed = getResultTool?.renderResult?.(
			getResultShell,
			{ expanded: false, isPartial: false },
			undefined,
			{ expanded: false, isPartial: false },
		);
		const getExpanded = getResultTool?.renderResult?.(
			getResultShell,
			{ expanded: true, isPartial: false },
			undefined,
			{ expanded: true, isPartial: false },
		);
		expect(rendered(getCollapsed)).toContain("Press Ctrl+O");
		expect(rendered(getExpanded)).toContain("Stored result preview");
	});
});
