/**
 * @fileoverview Aggregate Gemini ACP stored-result retrieval and local recall lookup tool.
 */
import { type Static, Type } from "@mariozechner/pi-ai";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiTool } from "./define.js";
import { geminiAcpGetResultTool } from "./gemini-get-result.js";
import { geminiAcpRecallTool } from "./gemini-recall.js";
import { renderGeminiToolCallTitle } from "./gemini-rendering.js";

const resultsActionSchema = Type.Union([
	Type.Literal("get"),
	Type.Literal("recall"),
]);

export const geminiResultsSchema = Type.Object({
	action: resultsActionSchema,
	responseId: Type.Optional(Type.String()),
	query: Type.Optional(Type.String()),
	k: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	since: Type.Optional(Type.String()),
	tool: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	bypassCache: Type.Optional(Type.Boolean()),
});

type Params = Static<typeof geminiResultsSchema>;

export const geminiResultsTool = defineGeminiTool({
	name: "gemini_results",
	label: "Gemini Results",
	description:
		"Get stored Gemini result by responseId or search local FTS recall.",
	parameters: geminiResultsSchema,
	execute(toolCallId, params: Params, signal, onUpdate, ctx) {
		if (params.action === "get") {
			return geminiAcpGetResultTool.execute(
				toolCallId,
				{ responseId: params.responseId ?? "" },
				signal,
				onUpdate,
				ctx,
			);
		}
		return geminiAcpRecallTool.execute(
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
			? geminiAcpRecallTool
			: geminiAcpGetResultTool;
		return target.renderResult!(result, options, theme, context);
	},
});

function isRecallResult(result: PiToolShell): boolean {
	const data = (result.details as Partial<ResultEnvelope<unknown>>).data;
	return Boolean(data && typeof data === "object" && "hits" in data);
}
