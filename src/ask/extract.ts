/**
 * @fileoverview Internal extraction route used by the gemini_ask umbrella tool.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import { type ExtractRunResult, runExtract } from "../prompt/extract.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import type { PiToolShell } from "../types.js";
import { type ToolRenderResultOptions, type ToolUpdate } from "../tools/define.js";
import {
	appendExpansionHint,
	isRecord,
	renderPromptToolResult,
	resultMetadataLines,
	storedOutputLine,
} from "../tools/gemini-prompt-rendering.js";
import { truncateToolText } from "../tools/gemini-rendering.js";
import { withToolResponseCache } from "../tools/cache.js";
import { errorResult, toolResult } from "../tools/result.js";

const askExtractParamsSchema = Type.Object({
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
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response-cache lookup for this call." }),
	),
});

type Params = Static<typeof askExtractParamsSchema>;

export const askExtractRoute = {
	async execute(
		_toolCallId: string,
		params: Params,
		signal: AbortSignal,
		onUpdate?: ToolUpdate,
	) {
		return withToolResponseCache({
			toolName: "gemini_extract",
			inputs: params,
			bypassCache: params.bypassCache,
			ttlMs: 7 * 24 * 60 * 60 * 1000,
			execute: async () => {
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
					text: formatExtractToolText(result),
					data: result,
					responseId: result.responseId,
					fullOutputPath: result.fullOutputPath,
				});
			},
		});
	},
	renderResult(
		result: PiToolShell,
		options: ToolRenderResultOptions,
		theme: unknown,
	) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_extract",
			isData: isExtractRunResult,
			collapsed: formatExtractCollapsedDisplay,
			expanded: formatExtractExpandedDisplay,
		});
	},
};

/** Formats the visible extract success text so assistants can answer from content[0].text even when details.data is hidden. */
export function formatExtractToolText(result: ExtractRunResult): string {
	const summary = summarizeExtractedValue(result.extracted);
	const lines = [
		`Gemini ACP extract returned JSON${summary ? ` (${summary})` : ""}.`,
		"",
		"Extracted JSON:",
		truncateToolText(formatJson(result.extracted), 4_000),
	];
	const stored = storedOutputLine(result);
	if (stored) lines.push("", `Raw output ${stored}.`);
	return lines.join("\n");
}

function formatExtractCollapsedDisplay(result: ExtractRunResult): string {
	const lines = formatExtractToolText(result).split("\n");
	return appendExpansionHint(
		lines,
		"the extracted JSON and raw output details",
	).join("\n");
}

function formatExtractExpandedDisplay(
	result: ExtractRunResult,
	shell: PiToolShell,
): string {
	const lines = [
		"Gemini ACP extract returned JSON.",
		`provider: ${result.provider}`,
		`responseLength: ${result.responseLength}`,
		`truncated: ${result.truncated}`,
		...resultMetadataLines(shell),
		"",
		"Extracted JSON:",
		formatJson(result.extracted),
	];
	if (result.metadata) {
		lines.push("", "Metadata:", formatJson(result.metadata));
	}
	if (result.rawText) {
		lines.push(
			"",
			"Raw output preview:",
			truncateToolText(result.rawText, 1_600),
		);
	}
	return lines.join("\n");
}

function summarizeExtractedValue(value: unknown): string {
	if (Array.isArray(value)) return `${value.length} item(s)`;
	if (isRecord(value)) {
		const keys = Object.keys(value);
		return keys.length ? `keys: ${keys.slice(0, 5).join(", ")}` : "object";
	}
	return typeof value;
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? "undefined";
}

function isExtractRunResult(value: unknown): value is ExtractRunResult {
	return (
		isRecord(value) &&
		value.provider === "gemini-acp" &&
		"extracted" in value &&
		typeof value.rawText === "string" &&
		typeof value.responseLength === "number" &&
		typeof value.truncated === "boolean"
	);
}

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
