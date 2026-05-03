import { type Static, Type } from "@mariozechner/pi-ai";
import { type ExtractRunResult, runExtract } from "../prompt/extract.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import type { PiToolShell } from "../types.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
import {
	appendExpansionHint,
	isRecord,
	renderPromptToolResult,
	resultMetadataLines,
	storedOutputLine,
} from "./gemini-prompt-rendering.js";
import {
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
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

const EXTRACT_TITLE_STATE_KEY = "geminiExtractTitle";

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
			text: formatExtractToolText(result),
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_extract",
			stateKey: EXTRACT_TITLE_STATE_KEY,
		});
	},
	renderResult(result, options, theme) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_extract",
			isData: isExtractRunResult,
			collapsed: formatExtractCollapsedDisplay,
			expanded: formatExtractExpandedDisplay,
		});
	},
});

/** Formats the visible gemini_extract success text so assistants can answer from content[0].text even when details.data is hidden. */
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
