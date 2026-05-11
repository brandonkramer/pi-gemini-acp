/** @file Internal summarization route used by the gemini_ask umbrella tool. */
import { type Static, Type } from "@earendil-works/pi-ai";

import {
	runSummarize,
	type SummarizeRunResult,
	type SummarizeUpdateHandler,
} from "../prompt/summarize.js";
import { withToolResponseCache } from "../tools/cache.js";
import { toolResultWithCost } from "../tools/cost-estimate.js";
import type { ToolRenderResultOptions, ToolUpdate } from "../tools/define.js";
import {
	appendExpansionHint,
	renderPromptToolResult,
	resultMetadataLines,
	storedOutputLine,
} from "../tools/gemini-prompt-rendering.js";
import { errorResult, toolResult } from "../tools/result.js";
import type { PiToolShell } from "../types.js";
import { isRecord } from "../utils/guards.js";
import { truncateToolText } from "../utils/text.js";

const askSummarizeParamsSchema = Type.Object({
	content: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Text to summarize; use content or url.",
		}),
	),
	url: Type.Optional(
		Type.String({
			description: "Safe public HTTP(S) URL; use url or content.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Optional content title." })),
	sentenceCount: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Approximate sentence count.",
		}),
	),
	bulletCount: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Exact bullet count.",
		}),
	),
	audience: Type.Optional(Type.String({ description: "Summary audience." })),
	style: Type.Optional(
		Type.Union([Type.Literal("paragraph"), Type.Literal("bullets"), Type.Literal("executive")]),
	),
	maxSourceCharacters: Type.Optional(
		Type.Number({
			minimum: 1000,
			maximum: 50000,
			description: "Max source chars sent to Gemini; default 20000.",
		}),
	),
	bypassCache: Type.Optional(Type.Boolean({ description: "Skip response cache." })),
});

type Params = Static<typeof askSummarizeParamsSchema>;

export const askSummarizeRoute = {
	async execute(toolCallId: string, params: Params, signal: AbortSignal, onUpdate?: ToolUpdate) {
		return await withToolResponseCache({
			toolName: "gemini_summarize",
			inputs: params,
			bypassCache: params.bypassCache,
			ttlMs: 7 * 24 * 60 * 60 * 1000,
			execute: async () => {
				const result = await runSummarize(params, {}, signal, summarizeToolUpdate(onUpdate));
				if (result.error) return errorResult(result.error);
				const truncationNote = result.source.truncated
					? ` Source truncated from ${result.source.contentLength} to ${result.source.preparedLength} characters before summarization.`
					: "";
				return toolResultWithCost(
					toolCallId,
					"gemini_ask",
					params.content ?? params.url ?? "",
					result.summary,
					{},
					{
						text: result.summaryTruncated
							? `Gemini ACP summary stored as responseId ${result.responseId ?? "(none)"}.${truncationNote} Preview:\n${result.summary}`
							: `Gemini ACP summary:${truncationNote}\n${result.summary}`,
						data: result,
						responseId: result.responseId,
						fullOutputPath: result.fullOutputPath,
					},
				);
			},
		});
	},
	renderResult(result: PiToolShell, options: ToolRenderResultOptions, theme: unknown) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_summarize",
			isData: isSummarizeRunResult,
			collapsed: formatSummarizeCollapsedDisplay,
			expanded: formatSummarizeExpandedDisplay,
		});
	},
};

function formatSummarizeCollapsedDisplay(result: SummarizeRunResult): string {
	const lines = [
		result.summaryTruncated
			? `Gemini ACP summary stored as responseId ${result.responseId ?? "(none)"}.`
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
	return appendExpansionHint(lines, "the full summary and source details").join("\n");
}

function formatSummarizeExpandedDisplay(result: SummarizeRunResult, shell: PiToolShell): string {
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

function summarizeToolUpdate(onUpdate: ToolUpdate | undefined): SummarizeUpdateHandler | undefined {
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
