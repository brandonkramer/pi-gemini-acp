import { describe, expect, it } from "vitest";
import type { PiToolShell } from "../../types.js";
import { geminiAcpTools } from "../register.js";

describe("gemini ACP tools smoke", () => {
	it("registers the standalone tool surface", () => {
		expect(geminiAcpTools.map((tool) => tool.name)).toEqual([
			"gemini_status",
			"gemini_prompt",
			"gemini_search",
			"gemini_research",
			"gemini_get_result",
		]);
	});

	it("returns Pi shell for local search", async () => {
		const tool = geminiAcpTools.find(
			(candidate) => candidate.name === "gemini_search",
		);
		const result = await tool?.execute(
			"x",
			{
				query: "alpha",
				localDocuments: [
					{ title: "Alpha", url: "https://example.com/", text: "alpha text" },
				],
			} as never,
			new AbortController().signal,
		);
		assertShell(result);
		expect(result?.content[0]?.text).toContain("1 result");
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
