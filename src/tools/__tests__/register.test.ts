/** @file Registration invariants for the Gemini tool adapter surface. */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { GeminiTool } from "../define.js";
import { registerGeminiAcpTools } from "../register.js";

const TOOLS_DIR = fileURLToPath(new URL("..", import.meta.url));

const PUBLIC_TOOL_FILES = [
	"gemini-analyze.ts",
	"gemini-ask.ts",
	"gemini-research.ts",
	"gemini-results.ts",
	"gemini-search.ts",
	"gemini-status.ts",
].toSorted();

describe("Gemini tool registration", () => {
	afterEach(() => {
		delete process.env.PI_GEMINI_ACP_RECALL;
	});

	it("does not register gemini_recall when recall is hard-disabled by env", () => {
		process.env.PI_GEMINI_ACP_RECALL = "0";
		const registered: string[] = [];

		registerGeminiAcpTools({
			registerTool(tool: GeminiTool) {
				registered.push(tool.name);
			},
		});

		expect(registered).not.toContain("gemini_recall");
		expect(registered).toContain("gemini_search");
	});

	it("keeps public tool adapters limited to the registered umbrella files", async () => {
		const files = (await readdir(TOOLS_DIR, { recursive: true })).filter((file) =>
			file.endsWith(".ts"),
		);
		const publicToolFiles: string[] = [];

		for (const file of files) {
			const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
			if (/export const \w+ = defineGeminiTool\(/u.test(source)) {
				publicToolFiles.push(file);
			}
		}

		expect(publicToolFiles.toSorted()).toEqual(PUBLIC_TOOL_FILES);
	});
});
