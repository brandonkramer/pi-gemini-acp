import { type Static, Type } from "@mariozechner/pi-ai";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import { runTranslate } from "../prompt/translate.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpTranslateSchema = Type.Object({
	text: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 80_000,
			description:
				"Single source text to translate. Provide either text or batch.",
		}),
	),
	batch: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(
					Type.String({ description: "Optional stable item id." }),
				),
				text: Type.String({
					minLength: 1,
					description: "Source text for this ordered batch item.",
				}),
			}),
			{
				minItems: 1,
				maxItems: 20,
				description:
					"Ordered batch items to translate. Provide either batch or text; partial item failures are returned in-order when Gemini emits valid batch JSON.",
			},
		),
	),
	targetLanguage: Type.String({
		minLength: 1,
		description: "Target language or locale, for example `Spanish` or `fr-CA`.",
	}),
	sourceLanguage: Type.Optional(
		Type.String({
			description: "Optional source language; omitted means auto-detect.",
		}),
	),
	tone: Type.Optional(
		Type.String({
			description:
				"Optional target tone/register, for example formal, casual, technical, or preserve source tone.",
		}),
	),
	glossary: Type.Optional(
		Type.Array(
			Type.Object({
				source: Type.String({ minLength: 1 }),
				target: Type.String({ minLength: 1 }),
				note: Type.Optional(Type.String()),
			}),
			{
				description:
					"Deterministic source→target term mappings Gemini must apply.",
			},
		),
	),
	preserve: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Terms, placeholders, product names, or code fragments Gemini must leave unchanged.",
		}),
	),
	preservationRules: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Additional deterministic preservation rules such as retaining ICU placeholders or Markdown links.",
		}),
	),
});

type Params = Static<typeof geminiAcpTranslateSchema>;

export const geminiAcpTranslateTool = defineGeminiTool({
	name: "gemini_translate",
	label: "Gemini ACP Translate",
	description:
		"Translate or localize text through configured, authenticated local Gemini ACP. No local/no-key fallback is available.",
	parameters: geminiAcpTranslateSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		const result = await runTranslate(
			params,
			{},
			signal,
			translateToolUpdate(onUpdate),
		);
		if (result.error) return errorResult(result.error);
		return toolResult({
			text: translateToolText(result),
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
});

type TranslateToolResult = Awaited<ReturnType<typeof runTranslate>>;

function translateToolUpdate(
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

function translateToolText(result: TranslateToolResult): string {
	if (result.truncated) {
		return `Gemini ACP translation stored as responseId ${result.responseId}. Preview:\n${result.text}`;
	}
	const headline =
		result.mode === "batch"
			? `Gemini ACP translated ${result.itemCount} item(s) to ${result.targetLanguage}.`
			: `Gemini ACP translation to ${result.targetLanguage}:`;
	return `${headline}\n${result.text}`;
}
