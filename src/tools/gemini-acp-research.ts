import { type Static, Type } from "@mariozechner/pi-ai";
import { runResearch } from "../research/run.js";
import { defineGeminiTool } from "./define.js";
import { toolResult } from "./result.js";

export const geminiAcpResearchSchema = Type.Object({
	query: Type.String({ description: "Research query." }),
	maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	hydrateSources: Type.Optional(
		Type.Boolean({
			description:
				"Fetch missing source text with the built-in safe fetch hydrator.",
		}),
	),
	hydrationMode: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("fetch")], {
			description:
				"Hydration mode. Extension-to-extension pi-scraper execution is not exposed by Pi here, so fetch is the automatic mode.",
		}),
	),
	sources: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.Optional(Type.String()),
				url: Type.String(),
				text: Type.Optional(Type.String()),
				snippet: Type.Optional(Type.String()),
			}),
		),
	),
});

type Params = Static<typeof geminiAcpResearchSchema>;

export const geminiAcpResearchTool = defineGeminiTool({
	name: "gemini_research",
	label: "Gemini ACP Research",
	description:
		"Run Gemini ACP-backed research with sources/citations. Can optionally hydrate missing source text with safe direct fetch.",
	parameters: geminiAcpResearchSchema,
	async execute(_toolCallId, params: Params, signal) {
		const result = await runResearch(
			{
				...params,
				hydrateSources:
					params.hydrationMode === "fetch" ? true : params.hydrateSources,
			},
			{},
			signal,
		);
		return toolResult({
			text: `${result.summary} responseId: ${result.responseId}`,
			data: result,
			responseId: result.responseId,
		});
	},
});
