import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { PiToolShell, ResultEnvelope } from "../../types.js";
import { geminiAcpTools } from "../register.js";

describe("gemini ACP tools smoke", () => {
	it("registers the standalone tool surface", () => {
		expect(geminiAcpTools.map((tool) => tool.name)).toEqual([
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
			"gemini_get_result",
		]);
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

	it("returns Pi shell for unsupported file analysis", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_file_analyze",
		);
		const result = await tool?.execute(
			"x",
			{ paths: ["README.md"], instructions: "Summarize this file." } as never,
			new AbortController().signal,
		);
		assertShell(result);
		expect(result?.content[0]?.text).toContain(
			"file/document input support is not confirmed",
		);
		expect(result?.details).toMatchObject({
			status: "error",
			error: { code: "GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE" },
		});
	});

	it("returns explicit unsupported-capability shell for image description", async () => {
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
		assertShell(result);
		expect(result?.details).toMatchObject({
			status: "error",
			error: { code: "GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED" },
		});
	});

	it("emits Pi shell progress updates for local research", async () => {
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
		expect(updates.length).toBeGreaterThan(0);
		expect(updates[0]?.details).toMatchObject({
			status: "progress",
			data: { progress: { phase: "search" } },
		});
	});
});

function assertShell(
	result: PiToolShell | undefined,
): asserts result is PiToolShell {
	expect(result?.content[0]?.type).toBe("text");
	expect(result?.details).toBeTruthy();
}
