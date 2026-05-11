import { type Static, Type } from "@earendil-works/pi-ai";

import { runSearch, type SearchProgressUpdate, type SearchRunResult } from "../search/run.js";
import type { PiToolShell } from "../types.js";
import { isRecord } from "../utils/guards.js";
import { truncateToolText } from "../utils/text.js";
import { withToolResponseCache } from "./cache.js";
import { cacheToolTitle, costToolTitle, estimateCost } from "./cost-estimate.js";
import { defineGeminiTool, type ToolRenderResultOptions, type ToolUpdate } from "./define.js";
import { formatToolDisplay, type ToolDisplaySpec } from "./gemini-prompt-rendering.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	renderGeminiToolCallTitle,
} from "./gemini-rendering.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpSearchSchema = Type.Object({
	query: Type.String(),
	maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	bypassCache: Type.Optional(Type.Boolean()),
	useRecall: Type.Optional(Type.Boolean()),
	bypassRecall: Type.Optional(Type.Boolean()),
	localDocuments: Type.Optional(
		Type.Array(Type.Object({ url: Type.String() }, { description: "opt:title,text,snippet" })),
	),
});

type Params = Static<typeof geminiAcpSearchSchema>;

type ProgressData = { progress: SearchProgressUpdate };

const SEARCH_TITLE_STATE_KEY = "geminiSearchTitle";

export const geminiAcpSearchTool = defineGeminiTool({
	name: "gemini_search",
	label: "Gemini ACP Search",
	description: "web/localDocs(no ACP);bypassCache fresh/news/current;useRecall",
	parameters: geminiAcpSearchSchema,
	async execute(toolCallId, params: Params, signal, onUpdate) {
		if (params.localDocuments?.length) {
			const result = await runSearch(
				params,
				{ onProgress: (update) => emitSearchProgress(update, onUpdate) },
				signal,
			);
			if (result.error) return errorResult(result.error);
			const cost = estimateCost(params.query, formatSearchModelPayload(result), {
				model: result.model,
				searchCount: 0,
			});
			const title = costToolTitle("gemini_search", cost);
			cacheToolTitle(toolCallId, title);
			return toolResult({
				text: formatSearchModelPayload(result),
				data: result,
				responseId: result.responseId,
				fullOutputPath: result.fullOutputPath,
				title,
			});
		}
		return await withToolResponseCache({
			toolName: "gemini_search",
			inputs: params,
			bypassCache: params.bypassCache,
			useRecall: params.useRecall,
			bypassRecall: params.bypassRecall,
			recallQuery: params.query,
			recallThreshold: 0.85,
			ttlMs: 60 * 60 * 1000,
			onCacheHit: (shell) => {
				if (shell.title) cacheToolTitle(toolCallId, shell.title);
			},
			execute: async () => {
				const result = await runSearch(
					params,
					{ onProgress: (update) => emitSearchProgress(update, onUpdate) },
					signal,
				);
				if (result.error) return errorResult(result.error);
				const cost = estimateCost(params.query, formatSearchModelPayload(result), {
					model: result.model,
					searchCount: 1,
				});
				const title = costToolTitle("gemini_search", cost);
				cacheToolTitle(toolCallId, title);
				return toolResult({
					text: formatSearchModelPayload(result),
					data: result,
					responseId: result.responseId,
					fullOutputPath: result.fullOutputPath,
					title,
				});
			},
		});
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_search",
			stateKey: SEARCH_TITLE_STATE_KEY,
		});
	},
	renderResult(result, options, theme) {
		return boxedToolText(dimToolText(formatSearchToolDisplay(result, options), theme));
	},
});

async function emitSearchProgress(
	update: SearchProgressUpdate,
	onUpdate?: ToolUpdate,
): Promise<void> {
	await onUpdate?.(
		toolResult({
			text: formatSearchProgressContent(update),
			status: "progress",
			data: { progress: update },
			responseId: update.responseId,
		}),
	);
}

const searchDisplaySpec: ToolDisplaySpec<SearchProgressUpdate, SearchRunResult> = {
	toolName: "gemini_search",
	progress: {
		test: isProgressData,
		extract: (d) => (d as { progress: SearchProgressUpdate }).progress,
		collapsed: formatSearchProgressCollapsed,
		expanded: formatSearchProgressExpanded,
	},
	result: {
		test: isSearchRunResult,
		extract: (d) => d as SearchRunResult,
		collapsed: formatSearchCollapsedDisplay,
		expanded: formatSearchExpandedDisplay,
	},
	includeErrorInFallback: true,
};

function formatSearchToolDisplay(result: PiToolShell, options: ToolRenderResultOptions): string {
	return formatToolDisplay(result, options, searchDisplaySpec);
}

function formatSearchProgressContent(update: SearchProgressUpdate): string {
	// Empty/error results intentionally do not emit a separate terminal progress event:
	// Pi marks the final render as non-partial after execute resolves, which stops the
	// spinner through renderCall(context.isPartial=false) while preserving final envelopes.
	return searchProgressLine(update);
}

function formatSearchProgressCollapsed(update: SearchProgressUpdate): string {
	return searchProgressLine(update);
}

function formatSearchProgressExpanded(update: SearchProgressUpdate): string {
	const lines = [
		`gemini_search ${update.phase}`,
		`query: ${update.query}`,
		`message: ${progressMessage(update)}`,
	];
	if (update.provider) lines.push(`provider: ${update.provider}`);
	if (update.model) lines.push(`model: ${update.model}`);
	if (update.maxResults !== undefined) lines.push(`maxResults: ${update.maxResults}`);
	if (update.resultCount !== undefined) lines.push(`resultCount: ${update.resultCount}`);
	if (update.responseId) lines.push(`responseId: ${update.responseId}`);
	if (update.chunk?.text) lines.push("latest chunk:", truncateToolText(update.chunk.text, 800));
	return lines.join("\n");
}

function searchProgressLine(update: SearchProgressUpdate): string {
	if (update.phase === "provider_stream") {
		const latest = update.chunk?.text.trim() ?? update.message;
		return `Searching: ${truncateToolText(latest, 220)}`;
	}
	return progressMessage(update);
}

function progressMessage(update: SearchProgressUpdate): string {
	if (update.phase === "provider_stream") return "Receiving Gemini ACP search response.";
	return update.message;
}

function formatSearchModelPayload(result: SearchRunResult): string {
	const lines = [
		`Gemini ACP search returned ${result.results.length} result(s).`,
		`provider: ${result.provider}`,
	];
	if (result.model) lines.push(`model: ${result.model}`);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath) lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	lines.push("", "Results:");
	if (result.results.length === 0) lines.push("No normalized search results.");
	for (const item of result.results) {
		lines.push(`${item.ranking}. ${item.title}`, `url: ${item.url}`);
		if (item.snippet) lines.push(`snippet: ${item.snippet}`);
	}
	return lines.join("\n");
}

function formatSearchCollapsedDisplay(result: SearchRunResult): string {
	const lines = [
		`Gemini ACP search returned ${result.results.length} result(s).`,
		expandedToolOutputHint("the top result, response ID, and storage details"),
	];
	return lines.join("\n");
}

function formatSearchExpandedDisplay(result: SearchRunResult): string {
	const lines = [
		`Gemini ACP search returned ${result.results.length} result(s).`,
		`provider: ${result.provider}`,
	];
	if (result.model) lines.push(`model: ${result.model}`);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath) lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	lines.push("", "Results:");
	if (result.results.length === 0) lines.push("No normalized search results.");
	for (const item of result.results) {
		lines.push(`${item.ranking}. ${item.title}`, `   url: ${item.url}`);
		if (item.snippet) lines.push(`   snippet: ${item.snippet}`);
	}
	return lines.join("\n");
}

function isProgressData(value: unknown): value is ProgressData {
	return isRecord(value) && isSearchProgressUpdate(value.progress);
}

function isSearchProgressUpdate(value: unknown): value is SearchProgressUpdate {
	return (
		isRecord(value) &&
		typeof value.phase === "string" &&
		typeof value.message === "string" &&
		typeof value.query === "string"
	);
}

function isSearchRunResult(value: unknown): value is SearchRunResult {
	return (
		isRecord(value) &&
		(value.provider === "local" || value.provider === "gemini-acp") &&
		Array.isArray(value.results)
	);
}
