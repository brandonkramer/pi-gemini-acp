import type { PiToolRegistrar } from "./define.js";
import { geminiAcpCodeReviewTool } from "./gemini-code-review.js";
import { geminiAcpExtractTool } from "./gemini-extract.js";
import { geminiAcpFileAnalyzeTool } from "./gemini-file-analyze.js";
import { geminiAcpGetResultTool } from "./gemini-get-result.js";
import { geminiAcpImageDescribeTool } from "./gemini-image-describe.js";
import { geminiAcpPromptTool } from "./gemini-prompt.js";
import { geminiAcpRecallTool } from "./gemini-recall.js";
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
	geminiAcpFileAnalyzeTool,
	geminiAcpCodeReviewTool,
	geminiAcpTranslateTool,
	geminiAcpImageDescribeTool,
	geminiAcpRecallTool,
	geminiAcpGetResultTool,
] as const;

export function registerGeminiAcpTools(pi: PiToolRegistrar): void {
	for (const tool of geminiAcpTools) {
		if (
			tool.name === "gemini_recall" &&
			process.env.PI_GEMINI_ACP_RECALL === "0"
		)
			continue;
		pi.registerTool(tool);
	}
}
