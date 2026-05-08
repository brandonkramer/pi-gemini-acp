/**
 * @fileoverview Aggregate Gemini ACP stored-result retrieval and local recall lookup tool.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiTool } from "./define.js";
import { renderGeminiToolCallTitle } from "./gemini-rendering.js";
import { resultsGetRoute } from "../results/get.js";
import { resultsRecallRoute } from "../results/recall.js";

const resultsActionSchema = Type.Enum({ get: "get", recall: "recall" });

export const geminiResultsSchema = Type.Object({
	action: resultsActionSchema,
	responseId: Type.Optional(Type.String()),
	query: Type.Optional(Type.String()),
	k: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	since: Type.Optional(Type.String()),
	tool: Type.Optional(Type.Any({ description: "string|string[]" })),
	bypassCache: Type.Optional(Type.Boolean()),
});

type Params = Static<typeof geminiResultsSchema>;

export const geminiResultsTool = defineGeminiTool({
	name: "gemini_results",
	label: "Gemini Results",
	description: "responseId/local FTS recall",
	parameters: geminiResultsSchema,
	execute(toolCallId, params: Params, signal, onUpdate, ctx) {
		if (params.action === "get") {
			return resultsGetRoute.execute(
				toolCallId,
				{ responseId: params.responseId ?? "" },
				signal,
				onUpdate,
				ctx,
			);
		}
		return resultsRecallRoute.execute(
			toolCallId,
			{
				query: params.query ?? "",
				k: params.k,
				minScore: params.minScore,
				since: params.since,
				tool: params.tool,
				bypassCache: params.bypassCache,
			},
			signal,
			onUpdate,
			ctx,
		);
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_results",
			stateKey: "geminiResultsTitle",
		});
	},
	renderResult(result, options, theme, context) {
		const target = isRecallResult(result)
			? resultsRecallRoute
			: resultsGetRoute;
		return target.renderResult!(result, options, theme, context);
	},
});

function isRecallResult(result: PiToolShell): boolean {
	const data = (result.details as Partial<ResultEnvelope<unknown>>).data;
	return Boolean(data && typeof data === "object" && "hits" in data);
}
