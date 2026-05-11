/** @file Registers the public Gemini tool surface exposed to Pi. */
import type { PiToolRegistrar } from "./define.js";
import { geminiAnalyzeTool } from "./gemini-analyze.js";
import { geminiAskTool } from "./gemini-ask.js";
import { geminiAcpResearchTool } from "./gemini-research.js";
import { geminiResultsTool } from "./gemini-results.js";
import { geminiAcpSearchTool } from "./gemini-search.js";
import { geminiAcpStatusTool } from "./gemini-status.js";

export const geminiAcpTools = [
	geminiAcpStatusTool,
	geminiAskTool,
	geminiAcpSearchTool,
	geminiAcpResearchTool,
	geminiAnalyzeTool,
	geminiResultsTool,
] as const;

export function registerGeminiAcpTools(pi: PiToolRegistrar): void {
	for (const tool of geminiAcpTools) {
		pi.registerTool(tool);
	}
}
