import type { PiToolRegistrar } from "./define.js";
import { geminiAcpCodeReviewTool } from "./gemini-code-review.js";
import { geminiAcpExtractTool } from "./gemini-extract.js";
import { geminiAcpGetResultTool } from "./gemini-get-result.js";
import { geminiAcpPromptTool } from "./gemini-prompt.js";
import { geminiAcpResearchTool } from "./gemini-research.js";
import { geminiAcpSearchTool } from "./gemini-search.js";
import { geminiAcpStatusTool } from "./gemini-status.js";
import { geminiAcpSummarizeTool } from "./gemini-summarize.js";
import { geminiAcpTranslateTool } from "./gemini-translate.js";

export const geminiAcpTools = [
	geminiAcpStatusTool,
	geminiAcpPromptTool,
	geminiAcpExtractTool,
	geminiAcpSummarizeTool,
	geminiAcpSearchTool,
	geminiAcpResearchTool,
	geminiAcpCodeReviewTool,
	geminiAcpTranslateTool,
	geminiAcpGetResultTool,
] as const;

export function registerGeminiAcpTools(pi: PiToolRegistrar): void {
	for (const tool of geminiAcpTools) pi.registerTool(tool);
}
