/** @file Registers the public Gemini tool surface exposed to Pi. */
import type { PiToolRegistrar } from "./define.ts";
import { geminiAnalyzeTool } from "./gemini-analyze.ts";
import { geminiAskTool } from "./gemini-ask.ts";
import { geminiAcpResearchTool } from "./gemini-research.ts";
import { geminiResultsTool } from "./gemini-results.ts";
import { geminiAcpSearchTool } from "./gemini-search.ts";
import { geminiAcpStatusTool } from "./gemini-status.ts";

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
