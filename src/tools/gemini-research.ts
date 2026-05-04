import { type Static, Type } from "@mariozechner/pi-ai";
import { type ResearchProgressUpdate, runResearch } from "../research/run.js";
import type {
	PiToolShell,
	ResearchCitation,
	ResearchFinding,
	ResearchResult,
	ResearchSource,
	ResultEnvelope,
} from "../types.js";
import {
	defineGeminiTool,
	type ToolRenderResultOptions,
	type ToolUpdate,
} from "./define.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
import { withToolResponseCache } from "./cache.js";
import { toolResult } from "./result.js";

export const geminiAcpResearchSchema = Type.Object({
	query: Type.String({ description: "Research query." }),
	maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	hydrateSources: Type.Optional(
		Type.Boolean({
			description:
				"Fetch missing source text with the built-in safe fetch hydrator.",
		}),
	),
	hydrationMode: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("fetch")], {
			description:
				"Hydration mode. Extension-to-extension pi-scraper execution is not exposed by Pi here, so fetch is the automatic mode.",
		}),
	),
	useCache: Type.Optional(
		Type.Boolean({ description: "Opt in to persistent response-cache reuse." }),
	),
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response-cache lookup for this call." }),
	),
	sources: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.Optional(Type.String()),
				url: Type.String(),
				text: Type.Optional(Type.String()),
				snippet: Type.Optional(Type.String()),
			}),
		),
	),
});

type Params = Static<typeof geminiAcpResearchSchema>;

type ProgressData = { progress: ResearchProgressUpdate };

const RESEARCH_TITLE_STATE_KEY = "geminiResearchTitle";

export const geminiAcpResearchTool = defineGeminiTool({
	name: "gemini_research",
	label: "Gemini ACP Research",
	description:
		"Run Gemini ACP-backed research with sources/citations. Can optionally hydrate missing source text with safe direct fetch.",
	parameters: geminiAcpResearchSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		return withToolResponseCache({
			toolName: "gemini_research",
			inputs: params,
			enabledByDefault: false,
			useCache: params.useCache,
			bypassCache: params.bypassCache,
			execute: async () => {
				const result = await runResearch(
					{
						...params,
						hydrateSources:
							params.hydrationMode === "fetch" ? true : params.hydrateSources,
					},
					{
						onProgress: (update) => emitResearchProgress(update, onUpdate),
					},
					signal,
				);
				return toolResult({
					text: formatResearchToolText(result),
					data: result,
					responseId: result.responseId,
					fullOutputPath: result.fullOutputPath,
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
		return boxedToolText(
			dimToolText(formatResearchToolDisplay(result, options), theme),
		);
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
	lines.push(
		"",
		"Collected source notes:",
		...formatResearchSourceNotes(result),
	);
	lines.push("", formatResearchAssistantGuidance());
	if (result.responseId) lines.push("", `responseId: ${result.responseId}`);
	if (result.fullOutputPath)
		lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	return lines.join("\n");
}

function formatResearchProviderLine(result: ResearchResult): string {
	const provider = result.provider ?? result.mode;
	return result.model
		? `Used: ${provider} via ${result.model}.`
		: `Used: ${provider}.`;
}

function formatResearchSourceNotes(result: ResearchResult): string[] {
	const findings = new Map(
		result.findings.map((finding) => [finding.sourceId, finding.text] as const),
	);
	const notes = result.sources
		.map((source) => formatSourceTakeaway(source, findings.get(source.id)))
		.filter((note) => note.length > 0)
		.slice(0, 5);
	return notes.length > 0
		? notes
		: ["- No source snippets or findings were assembled."];
}

function formatSourceTakeaway(
	source: ResearchSource,
	findingText: string | undefined,
): string {
	const text = cleanResearchTakeaway(source.snippet ?? findingText ?? "");
	if (!text) return "";
	const prefix = source.title ? `${source.title}: ` : "";
	return `- ${truncateToolText(`${prefix}${text}`, 260)}`;
}

function cleanResearchTakeaway(text: string): string {
	return text
		.replace(/\s+/gu, " ")
		.replace(/\[\d+\]/gu, "")
		.trim();
}

function formatResearchSourceQuality(
	result: ResearchResult,
): string | undefined {
	const missingText = result.sources.filter(
		(source) => !source.text?.trim(),
	).length;
	const blockedText = result.sources.filter((source) =>
		/blocked|cloudflare|attention required/iu.test(source.text ?? ""),
	).length;
	const notes: string[] = [];
	if (missingText) notes.push(`${missingText} source(s) had no hydrated text`);
	if (blockedText)
		notes.push(`${blockedText} hydrated page(s) looked blocked/noisy`);
	return notes.length
		? `${notes.join("; ")}; rely on snippets where full page text was unavailable.`
		: undefined;
}

function formatResearchAssistantGuidance(): string {
	return "Assistant response guidance: Synthesize a response in the structure that best fits the query and source notes; decide whether to include a summary, caveats, examples, comparison, table, recommendations, or next steps, then ask one concise contextual follow-up question.";
}

function formatResearchToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isProgressData(details.data)) {
		return formatCollapsedOrExpanded(details.data.progress, options, {
			collapsed: formatResearchProgressCollapsed,
			expanded: formatResearchProgressExpanded,
		});
	}
	if (isResearchResult(details.data)) {
		return formatCollapsedOrExpanded(details.data, options, {
			collapsed: formatResearchCollapsedDisplay,
			expanded: formatResearchExpandedDisplay,
		});
	}
	return result.content[0]?.text ?? details.error?.message ?? "gemini_research";
}

function formatResearchProgressCollapsed(
	update: ResearchProgressUpdate,
): string {
	return `${researchPhaseLabel(update.phase)}: ${progressMessageWithCounts(update)}`;
}

function formatResearchProgressExpanded(
	update: ResearchProgressUpdate,
): string {
	const lines = [
		`gemini_research ${update.phase}`,
		`phase: ${researchPhaseLabel(update.phase)}`,
		`message: ${update.message}`,
	];
	if (update.query) lines.push(`query: ${update.query}`);
	if (update.mode) lines.push(`mode: ${update.mode}`);
	if (update.provider) lines.push(`provider: ${update.provider}`);
	if (update.model) lines.push(`model: ${update.model}`);
	if (update.maxResults !== undefined)
		lines.push(`maxResults: ${update.maxResults}`);
	if (update.hydrateSources !== undefined)
		lines.push(`hydrateSources: ${update.hydrateSources}`);
	if (update.hydrationMode)
		lines.push(`hydrationMode: ${update.hydrationMode}`);
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
	if (
		update.completedSources !== undefined &&
		update.totalSources !== undefined
	) {
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
		expandedToolOutputHint(
			"sources, findings, citations, response ID, and storage details",
		),
	].join("\n");
}

function formatResearchExpandedDisplay(result: ResearchResult): string {
	const lines = [
		result.summary,
		`query: ${result.query}`,
		`mode: ${result.mode}`,
	];
	if (result.provider) lines.push(`provider: ${result.provider}`);
	if (result.model) lines.push(`model: ${result.model}`);
	lines.push(
		`sources: ${result.sources.length}`,
		`findings: ${result.findings.length}`,
		`citations: ${result.citations.length}`,
		formatHydrationNotes(result.sources),
	);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath)
		lines.push(`fullOutputPath: ${result.fullOutputPath}`);
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
	if (source.hydrated !== undefined)
		lines.push(`   hydrated: ${source.hydrated}`);
	if (source.snippet)
		lines.push(`   snippet: ${truncateToolText(source.snippet, 500)}`);
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
	return citations.map(formatResearchCitation);
}

function formatResearchCitation(
	citation: ResearchCitation,
	index: number,
): string {
	const lines = [
		`${index + 1}. sourceId: ${citation.sourceId}`,
		`   url: ${citation.url}`,
	];
	if (citation.marker) lines.push(`   marker: ${citation.marker}`);
	if (citation.startByte !== undefined || citation.endByte !== undefined) {
		lines.push(
			`   byteRange: ${citation.startByte ?? "?"}-${citation.endByte ?? "?"}`,
		);
	}
	if (citation.providerSources?.length) {
		lines.push(`   providerSources: ${citation.providerSources.length}`);
	}
	if (citation.text)
		lines.push(`   text: ${truncateToolText(citation.text, 500)}`);
	return lines.join("\n");
}

function isProgressData(value: unknown): value is ProgressData {
	return isRecord(value) && isResearchProgressUpdate(value.progress);
}

function isResearchProgressUpdate(
	value: unknown,
): value is ResearchProgressUpdate {
	return (
		isRecord(value) &&
		isResearchProgressPhase(value.phase) &&
		typeof value.message === "string"
	);
}

function isResearchProgressPhase(
	value: unknown,
): value is ResearchProgressUpdate["phase"] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
