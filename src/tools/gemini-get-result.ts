import { type Static, Type } from "@mariozechner/pi-ai";
import { getStoredResult } from "../storage/results.js";
import { defineGeminiTool } from "./define.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpGetResultSchema = Type.Object({
	responseId: Type.String({ description: "Stored result responseId." }),
});

type Params = Static<typeof geminiAcpGetResultSchema>;

export const geminiAcpGetResultTool = defineGeminiTool({
	name: "gemini_get_result",
	label: "Gemini ACP Get Result",
	description:
		"Retrieve full stored Gemini ACP search/research output by responseId.",
	parameters: geminiAcpGetResultSchema,
	async execute(_toolCallId, params: Params) {
		try {
			const stored = await getStoredResult(params.responseId);
			return toolResult({
				text: `Retrieved result ${params.responseId}.`,
				data: stored.value,
				responseId: params.responseId,
				fullOutputPath: stored.path,
			});
		} catch {
			return errorResult({
				code: "RESULT_NOT_FOUND",
				phase: "storage",
				message: `Result not found: ${params.responseId}`,
				retryable: false,
			});
		}
	},
});
