import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import type { PiToolShell } from "../../types.ts";
import { geminiAcpTools } from "../register.ts";
import { toolResult } from "../result.ts";

const rendered = (component: { render(width: number): string[] } | undefined) =>
	component?.render(120).join("\n") ?? "";

describe("Gemini tool renderers", () => {
	it("exposes custom collapsed/expanded renderers for every Gemini tool", () => {
		for (const name of [
			"gemini_status",
			"gemini_ask",
			"gemini_search",
			"gemini_research",
			"gemini_analyze",
			"gemini_results",
		] as const) {
			const tool = geminiAcpTools.find((candidate) => candidate.name === name);
			expect(tool?.renderCall).toBeTypeOf("function");
			expect(tool?.renderResult).toBeTypeOf("function");
		}
	});

	it("renders file analysis validation errors with expansion details", async () => {
		const tool = geminiAcpTools.find((candidate) => candidate.name === "gemini_analyze");
		const result = await tool?.execute(
			"x",
			{
				kind: "file",
				paths: [".env"],
				instructions: "Summarize this file.",
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
		expect(rendered(expanded)).toContain("GEMINI_FILE_ANALYZE_HIDDEN_PATH_REJECTED");
	});

	it("renders image validation results with expansion details", async () => {
		const tool = geminiAcpTools.find((candidate) => candidate.name === "gemini_analyze");
		const result = await tool?.execute(
			"x",
			{
				kind: "image",
				imageDataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
					"base64",
				),
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
		const statusTool = geminiAcpTools.find((candidate) => candidate.name === "gemini_status");
		const statusResult = await statusTool?.execute("x", {} as never, new AbortController().signal);
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

		const getResultTool = geminiAcpTools.find((candidate) => candidate.name === "gemini_results");
		const getResultShell: PiToolShell = toolResult({
			text: "Retrieved result abc123.",
			data: {
				query: "alpha",
				summary: "Research for alpha collected one source.",
				sources: [
					{ id: "s1", title: "Alpha", url: "https://example.com", text: "Alpha evidence." },
				],
				findings: [{ sourceId: "s1", text: "Alpha evidence supports the result." }],
				citations: [],
			},
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
		expect(rendered(getCollapsed)).toContain("sources: 1");
		expect(rendered(getCollapsed)).toContain("Press Ctrl+O");
		expect(rendered(getExpanded)).toContain("Top sources:");
		expect(rendered(getExpanded)).toContain("Next actions:");
	});
});
