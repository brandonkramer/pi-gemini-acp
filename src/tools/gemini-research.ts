import { type Static, Type } from "@earendil-works/pi-ai";

import { type ResearchProgressUpdate, runResearch } from "../research/run.ts";
import type {
	PiToolShell,
	ResearchCitation,
	ResearchFinding,
	ResearchResult,
	ResearchSource,
} from "../types.ts";
import { isRecord } from "../utils/guards.ts";
import { truncateToolText } from "../utils/text.ts";
import { withToolResponseCache } from "./cache.ts";
import { cacheToolTitle, costToolTitle, estimateCost } from "./cost-estimate.ts";
import { defineGeminiTool, type ToolRenderResultOptions, type ToolUpdate } from "./define.ts";
import { formatToolDisplay, type ToolDisplaySpec } from "./gemini-prompt-rendering.ts";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	renderGeminiToolCallTitle,
} from "./gemini-rendering.ts";
import { errorResult, toolResult } from "./result.ts";

const hydrationModeSchema = Type.Enum({ none: "none", fetch: "fetch" });

export const geminiAcpResearchSchema = Type.Object({
	query: Type.String(),
	maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	hydrateSources: Type.Optional(Type.Boolean()),
	hydrationMode: Type.Optional(hydrationModeSchema),
	useCache: Type.Optional(Type.Boolean()),
	bypassCache: Type.Optional(Type.Boolean()),
	useRecall: Type.Optional(Type.Boolean()),
	bypassRecall: Type.Optional(Type.Boolean()),
	sources: Type.Optional(
		Type.Array(Type.Object({ url: Type.String() }, { description: "opt:title,text,snippet" })),
	),
});

type Params = Static<typeof geminiAcpResearchSchema>;

type ProgressData = { progress: ResearchProgressUpdate };

const RESEARCH_TITLE_STATE_KEY = "geminiResearchTitle";

export const geminiAcpResearchTool = defineGeminiTool({
	name: "gemini_research",
	label: "Gemini ACP Research",
	description: "Sources/cites;safeFetch;cache/recall;bypassCache fresh/news/current",
	parameters: geminiAcpResearchSchema,
	async execute(toolCallId, params: Params, signal, onUpdate) {
		return await withToolResponseCache({
			toolName: "gemini_research",
			inputs: params,
			enabledByDefault: false,
			useCache: params.useCache,
			bypassCache: params.bypassCache,
			useRecall: params.useRecall,
			bypassRecall: params.bypassRecall,
			recallQuery: params.query,
			recallThreshold: 0.8,
			recallMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
			onCacheHit: (shell) => {
				if (shell.title) cacheToolTitle(toolCallId, shell.title);
			},
			execute: async () => {
				const result = await runResearch(
					{
						...params,
						hydrationMode: params.hydrationMode as "none" | "fetch" | undefined,
						hydrateSources: params.hydrationMode === "fetch" ? true : params.hydrateSources,
					},
					{
						onProgress: (update) => emitResearchProgress(update, onUpdate),
					},
					signal,
				);
				if (result.error) return errorResult(result.error);
				const cost = estimateCost(params.query, formatResearchToolText(result), {
					model: result.model,
					searchCount: 1,
				});
				const title = costToolTitle("gemini_research", cost);
				cacheToolTitle(toolCallId, title);
				return toolResult({
					text: formatResearchToolText(result),
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
			toolName: "gemini_research",
			stateKey: RESEARCH_TITLE_STATE_KEY,
		});
	},
	renderResult(result, options, theme) {
		return boxedToolText(dimToolText(formatResearchToolDisplay(result, options), theme));
	},
});

async function emitResearchProgress(
	update: ResearchProgressUpdate,
	onUpdate?: ToolUpdate,
): Promise<void> {
	await onUpdate?.(
		toolResult({
			text: `gemini_research ${update.phase}: ${update.message}`,
			status: "progress",
			data: { progress: update },
			responseId: update.responseId,
		}),
	);
}

export function formatResearchToolText(result: ResearchResult): string {
	const lines = [
		"Gemini research summary:",
		`Researched: ${result.query}`,
		formatResearchProviderLine(result),
		`Collected: ${result.sources.length} source(s); findings: ${result.findings.length}; citations: ${result.citations.length}.`,
	];
	const sourceQuality = formatResearchSourceQuality(result);
	if (sourceQuality) lines.push(`Source quality signal: ${sourceQuality}`);
	lines.push("", "Collected source notes:", ...formatResearchSourceNotes(result));
	lines.push("", formatResearchAssistantGuidance());
	if (result.responseId) lines.push("", `responseId: ${result.responseId}`);
	if (result.fullOutputPath) lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	return lines.join("\n");
}

function formatResearchProviderLine(result: ResearchResult): string {
	const provider = result.provider ?? result.mode;
	return result.model ? `Used: ${provider} via ${result.model}.` : `Used: ${provider}.`;
}

function formatResearchSourceNotes(result: ResearchResult): string[] {
	const findings = new Map(
		result.findings.map((finding) => [finding.sourceId, finding.text] as const),
	);
	const notes = result.sources
		.map((source) => formatSourceTakeaway(source, findings.get(source.id)))
		.filter((note) => note.length > 0)
		.slice(0, 5);
	return notes.length > 0 ? notes : ["- No source snippets or findings were assembled."];
}

function formatSourceTakeaway(source: ResearchSource, findingText: string | undefined): string {
	const text = cleanResearchTakeaway(source.snippet ?? findingText ?? "");
	if (!text) return "";
	const prefix = source.title ? `${source.title}: ` : "";
	return `- ${truncateToolText(`${prefix}${text}`, 260)}`;
}

function cleanResearchTakeaway(text: string): string {
	return text
		.replaceAll(/\s+/gu, " ")
		.replaceAll(/\[\d+\]/gu, "")
		.trim();
}

function formatResearchSourceQuality(result: ResearchResult): string | undefined {
	let missingText = 0;
	let blockedText = 0;
	for (const source of result.sources) {
		const text = source.text;
		if (!text?.trim()) {
			missingText += 1;
		} else if (/blocked|cloudflare|attention required/iu.test(text)) {
			blockedText += 1;
		}
	}
	const notes: string[] = [];
	if (missingText) notes.push(`${missingText} source(s) had no hydrated text`);
	if (blockedText) notes.push(`${blockedText} hydrated page(s) looked blocked/noisy`);
	return notes.length > 0
		? `${notes.join("; ")}; rely on snippets where full page text was unavailable.`
		: undefined;
}

function formatResearchAssistantGuidance(): string {
	return "Assistant response guidance: Synthesize a response in the structure that best fits the query and source notes; decide whether to include a summary, caveats, examples, comparison, table, recommendations, or next steps, then ask one concise contextual follow-up question.";
}

const researchDisplaySpec: ToolDisplaySpec<ResearchProgressUpdate, ResearchResult> = {
	toolName: "gemini_research",
	progress: {
		test: isProgressData,
		extract: (d) => (d as { progress: ResearchProgressUpdate }).progress,
		collapsed: formatResearchProgressCollapsed,
		expanded: formatResearchProgressExpanded,
	},
	result: {
		test: isResearchResult,
		extract: (d) => d as ResearchResult,
		collapsed: formatResearchCollapsedDisplay,
		expanded: formatResearchExpandedDisplay,
	},
	includeErrorInFallback: true,
};

function formatResearchToolDisplay(result: PiToolShell, options: ToolRenderResultOptions): string {
	return formatToolDisplay(result, options, researchDisplaySpec);
}

function formatResearchProgressCollapsed(update: ResearchProgressUpdate): string {
	return `${researchPhaseLabel(update.phase)}: ${progressMessageWithCounts(update)}`;
}

function formatResearchProgressExpanded(update: ResearchProgressUpdate): string {
	const lines = [
		`gemini_research ${update.phase}`,
		`phase: ${researchPhaseLabel(update.phase)}`,
		`message: ${update.message}`,
	];
	if (update.query) lines.push(`query: ${update.query}`);
	if (update.mode) lines.push(`mode: ${update.mode}`);
	if (update.provider) lines.push(`provider: ${update.provider}`);
	if (update.model) lines.push(`model: ${update.model}`);
	if (update.maxResults !== undefined) lines.push(`maxResults: ${update.maxResults}`);
	if (update.hydrateSources !== undefined) lines.push(`hydrateSources: ${update.hydrateSources}`);
	if (update.hydrationMode) lines.push(`hydrationMode: ${update.hydrationMode}`);
	const counts = progressCounts(update);
	if (counts) lines.push(`sources: ${counts}`);
	if (update.responseId) lines.push(`responseId: ${update.responseId}`);
	return lines.join("\n");
}

function progressMessageWithCounts(update: ResearchProgressUpdate): string {
	const counts = progressCounts(update);
	return counts ? `${update.message} (${counts})` : update.message;
}

function progressCounts(update: ResearchProgressUpdate): string | undefined {
	if (update.completedSources !== undefined && update.totalSources !== undefined) {
		return `${update.completedSources}/${update.totalSources}`;
	}
	return undefined;
}

function researchPhaseLabel(phase: ResearchProgressUpdate["phase"]): string {
	switch (phase) {
		case "search":
			return "Collecting sources";
		case "hydrate":
			return "Hydrating sources";
		case "assemble":
			return "Assembling findings";
		case "store":
			return "Storing result";
		case "done":
			return "Research complete";
	}
}

function formatResearchCollapsedDisplay(result: ResearchResult): string {
	return [
		result.summary,
		`sources: ${result.sources.length}; findings: ${result.findings.length}; citations: ${result.citations.length}`,
		expandedToolOutputHint("sources, findings, citations, response ID, and storage details"),
	].join("\n");
}

function formatResearchExpandedDisplay(result: ResearchResult): string {
	const lines = [result.summary, `query: ${result.query}`, `mode: ${result.mode}`];
	if (result.provider) lines.push(`provider: ${result.provider}`);
	if (result.model) lines.push(`model: ${result.model}`);
	lines.push(
		`sources: ${result.sources.length}`,
		`findings: ${result.findings.length}`,
		`citations: ${result.citations.length}`,
		formatHydrationNotes(result.sources),
	);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath) lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	lines.push(
		"",
		"Sources:",
		...formatResearchSources(result.sources),
		"",
		"Findings:",
		...formatResearchFindings(result.findings),
		"",
		"Citations:",
		...formatResearchCitations(result.citations),
	);
	return lines.join("\n");
}

function formatHydrationNotes(sources: ResearchSource[]): string {
	const hydrated = sources.filter((source) => source.hydrated).length;
	const withText = sources.filter((source) => source.text?.trim()).length;
	return `hydration: ${hydrated} hydrated; ${withText}/${sources.length} source(s) with text`;
}

function formatResearchSources(sources: ResearchSource[]): string[] {
	if (sources.length === 0) return ["No sources collected."];
	return sources.flatMap((source) => formatResearchSource(source));
}

function formatResearchSource(source: ResearchSource): string[] {
	const lines = [
		`${source.id}. ${source.title ?? source.url}`,
		`   url: ${source.url}`,
		`   normalizedUrl: ${source.normalizedUrl}`,
		`   text: ${source.text?.trim() ? "present" : "missing"}`,
	];
	if (source.provider) lines.push(`   provider: ${source.provider}`);
	if (source.hydrated !== undefined) lines.push(`   hydrated: ${source.hydrated}`);
	if (source.snippet) lines.push(`   snippet: ${truncateToolText(source.snippet, 500)}`);
	if (source.providerMetadata) lines.push("   providerMetadata: present");
	return lines;
}

function formatResearchFindings(findings: ResearchFinding[]): string[] {
	if (findings.length === 0) return ["No findings assembled."];
	return findings.map(
		(finding, index) =>
			`${index + 1}. sourceId: ${finding.sourceId}\n   ${truncateToolText(finding.text, 800)}`,
	);
}

function formatResearchCitations(citations: ResearchCitation[]): string[] {
	if (citations.length === 0) return ["No citations assembled."];
	// oxlint-disable-next-line unicorn/no-array-callback-reference -- formatResearchCitation intentionally consumes (citation, index)
	return citations.map(formatResearchCitation);
}

function formatResearchCitation(citation: ResearchCitation, index: number): string {
	const lines = [`${index + 1}. sourceId: ${citation.sourceId}`, `   url: ${citation.url}`];
	if (citation.marker) lines.push(`   marker: ${citation.marker}`);
	if (citation.startByte !== undefined || citation.endByte !== undefined) {
		lines.push(`   byteRange: ${citation.startByte ?? "?"}-${citation.endByte ?? "?"}`);
	}
	if (citation.providerSources?.length) {
		lines.push(`   providerSources: ${citation.providerSources.length}`);
	}
	if (citation.text) lines.push(`   text: ${truncateToolText(citation.text, 500)}`);
	return lines.join("\n");
}

function isProgressData(value: unknown): value is ProgressData {
	return isRecord(value) && isResearchProgressUpdate(value.progress);
}

function isResearchProgressUpdate(value: unknown): value is ResearchProgressUpdate {
	return (
		isRecord(value) && isResearchProgressPhase(value.phase) && typeof value.message === "string"
	);
}

function isResearchProgressPhase(value: unknown): value is ResearchProgressUpdate["phase"] {
	return (
		value === "search" ||
		value === "hydrate" ||
		value === "assemble" ||
		value === "store" ||
		value === "done"
	);
}

function isResearchResult(value: unknown): value is ResearchResult {
	return (
		isRecord(value) &&
		typeof value.summary === "string" &&
		typeof value.query === "string" &&
		(value.mode === "local" || value.mode === "gemini-acp") &&
		Array.isArray(value.sources) &&
		Array.isArray(value.findings) &&
		Array.isArray(value.citations)
	);
}
