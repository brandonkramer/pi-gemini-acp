import { afterEach, describe, expect, it } from "vitest";
import type { GeminiTool } from "../define.js";
import { registerGeminiAcpTools } from "../register.js";

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
});
