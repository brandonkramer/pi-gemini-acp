import { type Static, Type } from "@mariozechner/pi-ai";
import {
	runSummarize,
	type SummarizeRunResult,
	type SummarizeUpdateHandler,
} from "../prompt/summarize.js";
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

export const geminiAcpSummarizeSchema = Type.Object({
	content: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Text content to summarize. Provide either content or url.",
		}),
	),
	url: Type.Optional(
		Type.String({
			description:
				"Public HTTP(S) URL to fetch with safe direct-fetch guards. Provide either url or content.",
		}),
	),
	title: Type.Optional(
		Type.String({ description: "Optional title for supplied content." }),
	),
	sentenceCount: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Approximate number of sentences to return.",
		}),
	),
	bulletCount: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Exact number of concise bullets to return.",
		}),
	),
	audience: Type.Optional(
		Type.String({ description: "Optional intended audience for the summary." }),
	),
	style: Type.Optional(
		Type.Union([
			Type.Literal("paragraph"),
			Type.Literal("bullets"),
			Type.Literal("executive"),
		]),
	),
	maxSourceCharacters: Type.Optional(
		Type.Number({
			minimum: 1000,
			maximum: 50000,
			description:
				"Maximum normalized source characters to send to Gemini ACP. Defaults to 20000.",
		}),
	),
});

type Params = Static<typeof geminiAcpSummarizeSchema>;

const SUMMARIZE_TITLE_STATE_KEY = "geminiSummarizeTitle";

export const geminiAcpSummarizeTool = defineGeminiTool({
	name: "gemini_summarize",
	label: "Gemini ACP Summarize",
	description:
		"Summarize one supplied content item or one safe public HTTP(S) URL with configured Gemini ACP. Does not perform research or multi-source synthesis.",
	parameters: geminiAcpSummarizeSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		const result = await runSummarize(
			params,
			{},
			signal,
			summarizeToolUpdate(onUpdate),
		);
		if (result.error) return errorResult(result.error);
		const truncationNote = result.source.truncated
			? ` Source truncated from ${result.source.contentLength} to ${result.source.preparedLength} characters before summarization.`
			: "";
		return toolResult({
			text: result.summaryTruncated
				? `Gemini ACP summary stored as responseId ${result.responseId}.${truncationNote} Preview:\n${result.summary}`
				: `Gemini ACP summary:${truncationNote}\n${result.summary}`,
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_summarize",
			stateKey: SUMMARIZE_TITLE_STATE_KEY,
		});
	},
	renderResult(result, options, theme) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_summarize",
			isData: isSummarizeRunResult,
			collapsed: formatSummarizeCollapsedDisplay,
			expanded: formatSummarizeExpandedDisplay,
		});
	},
});

function formatSummarizeCollapsedDisplay(result: SummarizeRunResult): string {
	const lines = [
		result.summaryTruncated
			? `Gemini ACP summary stored as responseId ${result.responseId}.`
			: "Gemini ACP summary received.",
		`Source: ${formatSourceSummary(result)}`,
		`Preview: ${truncateToolText(result.summary, 260)}`,
	];
	if (result.source.truncated) {
		lines.splice(
			2,
			0,
			`Source truncated from ${result.source.contentLength} to ${result.source.preparedLength} characters.`,
		);
	}
	return appendExpansionHint(lines, "the full summary and source details").join(
		"\n",
	);
}

function formatSummarizeExpandedDisplay(
	result: SummarizeRunResult,
	shell: PiToolShell,
): string {
	const lines = [
		"Gemini ACP summary:",
		result.summary,
		"",
		`provider: ${result.provider}`,
		`summaryLength: ${result.summaryLength}`,
		`summaryTruncated: ${result.summaryTruncated}`,
		...resultMetadataLines(shell),
		"",
		"Source:",
		`kind: ${result.source.kind}`,
	];
	if (result.source.url) lines.push(`url: ${result.source.url}`);
	if (result.source.title) lines.push(`title: ${result.source.title}`);
	lines.push(
		`contentLength: ${result.source.contentLength}`,
		`preparedLength: ${result.source.preparedLength}`,
		`truncated: ${result.source.truncated}`,
		`maxSourceCharacters: ${result.source.maxSourceCharacters}`,
	);
	const stored = storedOutputLine(result);
	if (stored) lines.push("", `storage: ${stored}`);
	return lines.join("\n");
}

function formatSourceSummary(result: SummarizeRunResult): string {
	if (result.source.url) return result.source.url;
	if (result.source.title) return result.source.title;
	return result.source.kind;
}

function isSummarizeRunResult(value: unknown): value is SummarizeRunResult {
	return (
		isRecord(value) &&
		value.provider === "gemini-acp" &&
		typeof value.summary === "string" &&
		typeof value.summaryLength === "number" &&
		typeof value.summaryTruncated === "boolean" &&
		isRecord(value.source)
	);
}

function summarizeToolUpdate(
	onUpdate: ToolUpdate | undefined,
): SummarizeUpdateHandler | undefined {
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
