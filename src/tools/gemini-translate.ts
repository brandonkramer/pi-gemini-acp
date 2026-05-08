import { type Static, Type } from "@mariozechner/pi-ai";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import { runTranslate, type TranslateRunResult } from "../prompt/translate.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import {
	defineGeminiTool,
	type ToolRenderResultOptions,
	type ToolUpdate,
} from "./define.js";
import { isPromptWorkflowUpdate, isRecord } from "./gemini-prompt-rendering.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
import { withToolResponseCache } from "./cache.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpTranslateSchema = Type.Object({
	text: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 80_000,
			description: "Text to translate; use text or batch.",
		}),
	),
	batch: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.String({ description: "Stable item id." })),
				text: Type.String({
					minLength: 1,
					description: "Batch item text.",
				}),
			}),
			{
				minItems: 1,
				maxItems: 20,
				description: "Batch items; use batch or text.",
			},
		),
	),
	targetLanguage: Type.String({
		minLength: 1,
		description: "Target language or locale.",
	}),
	sourceLanguage: Type.Optional(
		Type.String({ description: "Source language; omit to auto-detect." }),
	),
	tone: Type.Optional(Type.String({ description: "Target tone/register." })),
	glossary: Type.Optional(
		Type.Array(
			Type.Object({
				source: Type.String({ minLength: 1 }),
				target: Type.String({ minLength: 1 }),
				note: Type.Optional(Type.String()),
			}),
			{ description: "Required source→target terms." },
		),
	),
	preserve: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Terms/placeholders to keep unchanged.",
		}),
	),
	preservationRules: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Extra preservation rules.",
		}),
	),
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response cache." }),
	),
});

type Params = Static<typeof geminiAcpTranslateSchema>;

type TranslateProgressData = { progress: PromptWorkflowUpdate };

const TRANSLATE_TITLE_STATE_KEY = "geminiTranslateTitle";

export const geminiAcpTranslateTool = defineGeminiTool({
	name: "gemini_translate",
	label: "Gemini ACP Translate",
	description: "Translate/localize text with Gemini ACP; no local fallback.",
	parameters: geminiAcpTranslateSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		return withToolResponseCache({
			toolName: "gemini_translate",
			inputs: params,
			bypassCache: params.bypassCache,
			execute: async () => {
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
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_translate",
			stateKey: TRANSLATE_TITLE_STATE_KEY,
		});
	},
	renderResult(result, options, theme) {
		return boxedToolText(
			dimToolText(formatTranslateToolDisplay(result, options), theme),
		);
	},
});

function translateToolUpdate(
	onUpdate: ToolUpdate | undefined,
): ((update: PromptWorkflowUpdate) => Promise<void>) | undefined {
	if (!onUpdate) return undefined;
	return async (update) => {
		await onUpdate(
			toolResult({
				text: update.text,
				data: { progress: update },
				status: update.type === "chunk" ? "streaming" : "running",
			}),
		);
	};
}

function translateToolText(result: TranslateRunResult): string {
	if (result.truncated) {
		return `Gemini ACP translation stored as responseId ${result.responseId}. Preview:\n${result.text}`;
	}
	const headline =
		result.mode === "batch"
			? `Gemini ACP translated ${result.itemCount} item(s) to ${result.targetLanguage}.`
			: `Gemini ACP translation to ${result.targetLanguage}:`;
	return `${headline}\n${result.text}`;
}

function formatTranslateToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isTranslateProgressData(details.data)) {
		return formatCollapsedOrExpanded(details.data.progress, options, {
			collapsed: formatTranslateProgressCollapsed,
			expanded: formatTranslateProgressExpanded,
		});
	}
	if (isTranslateRunResult(details.data)) {
		return formatCollapsedOrExpanded(details.data, options, {
			collapsed: formatTranslateCollapsedDisplay,
			expanded: formatTranslateExpandedDisplay,
		});
	}
	return (
		result.content[0]?.text ?? details.error?.message ?? "gemini_translate"
	);
}

function formatTranslateProgressCollapsed(
	update: PromptWorkflowUpdate,
): string {
	if (update.type === "chunk") {
		return `Translating: ${truncateToolText(update.text.trim(), 220)}`;
	}
	return update.text;
}

function formatTranslateProgressExpanded(update: PromptWorkflowUpdate): string {
	if (update.type === "chunk") {
		return [
			"gemini_translate streaming",
			"latest chunk:",
			truncateToolText(update.text, 800),
			"accumulated preview:",
			truncateToolText(update.accumulatedText, 1_200),
		].join("\n");
	}
	return [
		"gemini_translate progress",
		`phase: ${update.phase}`,
		`message: ${update.text}`,
	].join("\n");
}

function formatTranslateCollapsedDisplay(result: TranslateRunResult): string {
	const lines = [formatTranslateCollapsedHeadline(result)];
	if (result.mode === "single" && result.text) {
		lines.push(truncateToolText(result.text, 220));
	}
	if (result.mode === "batch" || result.truncated || result.text.length > 220) {
		lines.push(
			expandedToolOutputHint(
				"the full translation, response ID, and structured details",
			),
		);
	}
	return lines.join("\n");
}

function formatTranslateCollapsedHeadline(result: TranslateRunResult): string {
	if (result.mode === "batch") {
		return `Gemini ACP translated ${result.itemCount} item(s) to ${result.targetLanguage}.`;
	}
	return `Gemini ACP translation to ${result.targetLanguage}:`;
}

function formatTranslateExpandedDisplay(result: TranslateRunResult): string {
	const lines = [translateToolText(result), "", "Details:"];
	lines.push(`provider: ${result.provider}`);
	lines.push(`mode: ${result.mode}`);
	lines.push(`targetLanguage: ${result.targetLanguage}`);
	if (result.sourceLanguage)
		lines.push(`sourceLanguage: ${result.sourceLanguage}`);
	if (result.tone) lines.push(`tone: ${result.tone}`);
	lines.push(`itemCount: ${result.itemCount}`);
	lines.push(`responseLength: ${result.responseLength}`);
	lines.push(`truncated: ${result.truncated}`);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath)
		lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	if (result.items) {
		lines.push("items:");
		for (const item of result.items) {
			const label = item.id ? `${item.index} (${item.id})` : `${item.index}`;
			const status = item.error ? `error: ${item.error}` : "ok";
			lines.push(`- ${label}: ${status}`);
		}
	}
	return lines.join("\n");
}

function isTranslateProgressData(
	value: unknown,
): value is TranslateProgressData {
	return isRecord(value) && isPromptWorkflowUpdate(value.progress);
}

function isTranslateRunResult(value: unknown): value is TranslateRunResult {
	return (
		isRecord(value) &&
		value.provider === "gemini-acp" &&
		(value.mode === "single" || value.mode === "batch") &&
		typeof value.targetLanguage === "string" &&
		typeof value.text === "string"
	);
}
