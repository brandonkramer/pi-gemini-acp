import type { PiToolRegistrar } from "./define.js";
import { geminiAcpGetResultTool } from "./gemini-get-result.js";
import { geminiAcpResearchTool } from "./gemini-research.js";
import { geminiAcpSearchTool } from "./gemini-search.js";

export const geminiAcpTools = [
	geminiAcpSearchTool,
	geminiAcpResearchTool,
	geminiAcpGetResultTool,
] as const;

export function registerGeminiAcpTools(pi: PiToolRegistrar): void {
	for (const tool of geminiAcpTools) pi.registerTool(tool);
}
