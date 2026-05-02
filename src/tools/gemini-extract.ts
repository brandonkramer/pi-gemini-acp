import { type Static, Type } from "@mariozechner/pi-ai";
import { runExtract } from "../prompt/extract.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpExtractSchema = Type.Object({
	content: Type.String({
		minLength: 1,
		description: "Text content to extract structured data from.",
	}),
	prompt: Type.String({
		minLength: 1,
		description: "Extraction instructions for Gemini ACP.",
	}),
	schema: Type.Any({
		description:
			"JSON-schema-like output shape. Supported keywords: type, properties, required, items, additionalProperties, enum, title, description.",
	}),
});

type Params = Static<typeof geminiAcpExtractSchema>;

export const geminiAcpExtractTool = defineGeminiTool({
	name: "gemini_extract",
	label: "Gemini ACP Extract",
	description:
		"Extract structured JSON from supplied content with configured/authenticated Gemini ACP. Requires local ACP setup/auth and validates the returned JSON.",
	parameters: geminiAcpExtractSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		const result = await runExtract(
			params,
			{},
			signal,
			extractToolUpdate(onUpdate),
		);
		if (result.error) {
			return errorResult(result.error, result.error.message, {
				responseId: result.responseId,
				fullOutputPath: result.fullOutputPath,
				data: result,
			});
		}
		return toolResult({
			text: result.responseId
				? `Gemini ACP extract returned JSON. Raw output stored as responseId ${result.responseId}.`
				: "Gemini ACP extract returned JSON.",
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
});

function extractToolUpdate(
	onUpdate: ToolUpdate | undefined,
): ((update: PromptWorkflowUpdate) => Promise<void>) | undefined {
	if (!onUpdate) return undefined;
	return async (update) => {
		await onUpdate(
			toolResult({
				text: update.text,
				data: update,
				status: update.type === "chunk" ? "streaming" : "running",
			}),
		);
	};
}
