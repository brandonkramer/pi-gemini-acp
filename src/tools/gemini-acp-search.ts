import { type Static, Type } from "@mariozechner/pi-ai";
import { runSearch } from "../search/run.js";
import { defineGeminiTool } from "./define.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpSearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
	maxResults: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Maximum Gemini ACP results.",
		}),
	),
	localDocuments: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.Optional(Type.String()),
				url: Type.String(),
				text: Type.Optional(Type.String()),
				snippet: Type.Optional(Type.String()),
			}),
			{ description: "Optional local/no-key search corpus." },
		),
	),
});

type Params = Static<typeof geminiAcpSearchSchema>;

export const geminiAcpSearchTool = defineGeminiTool({
	name: "gemini_search",
	label: "Gemini ACP Search",
	description:
		"Run structured search through configured Gemini ACP, or local documents when provided.",
	parameters: geminiAcpSearchSchema,
	async execute(_toolCallId, params: Params, signal) {
		const result = await runSearch(params, {}, signal);
		if (result.error) return errorResult(result.error);
		return toolResult({
			text: `Gemini ACP search returned ${result.results.length} result(s).`,
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
});
