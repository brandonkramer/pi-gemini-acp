import type { PiToolRegistrar } from "./define.js";
import { geminiAcpGetResultTool } from "./gemini-get-result.js";
import { geminiAcpPromptTool } from "./gemini-prompt.js";
import { geminiAcpResearchTool } from "./gemini-research.js";
import { geminiAcpSearchTool } from "./gemini-search.js";
import { geminiAcpStatusTool } from "./gemini-status.js";

export const geminiAcpTools = [
	geminiAcpStatusTool,
	geminiAcpPromptTool,
	geminiAcpSearchTool,
	geminiAcpResearchTool,
	geminiAcpGetResultTool,
] as const;

export function registerGeminiAcpTools(pi: PiToolRegistrar): void {
	for (const tool of geminiAcpTools) pi.registerTool(tool);
}
