/** @file Shapes stored Gemini results into concise agent-facing views. */
import type { StructuredError } from "../types.ts";
import { isRecord } from "../utils/guards.ts";
import { pageItems, pageText, type PageResult } from "./pagination.ts";
import type {
	NextAction,
	QualitySignals,
	SourceNote,
	StoredResultDiagnostics,
	StoredResultGetData,
	StoredResultKind,
	StoredResultOverviewData,
	StoredResultRawData,
	StoredResultSourceData,
} from "./shape-types.ts";
import {
	buildQualitySignals,
	collectSourceDetails,
	detectStoredResultKind,
	keyFindings,
	type PayloadView,
	resultQuery,
	resultSummary,
	unwrapStoredPayload,
} from "./source-notes.ts";

const OVERVIEW_SOURCE_LIMIT = 5;
const OVERVIEW_SOURCE_LIMIT_MAX = 20;
const SOURCE_TEXT_LIMIT = 2_000;
const SOURCE_TEXT_LIMIT_MAX = 6_000;
const RAW_TEXT_LIMIT = 4_000;
const RAW_TEXT_LIMIT_MAX = 8_000;

const ASSISTANT_GUIDANCE =
	"Use answerContext as the primary evidence. Use sourceNotes and qualitySignals to ground claims and calibrate confidence. Treat resultId as a continuation handle, not as the answer. Do not repeat diagnostics unless the user asks about tool behavior.";

export interface StoredResultShapeContext {
	responseId: string;
	fullOutputPath?: string;
	value: unknown;
}

export interface StoredResultPageOptions {
	cursor?: string;
	limit?: number;
	sourceId?: string;
}

export function shapeStoredResultOverview(
	context: StoredResultShapeContext,
	options: StoredResultPageOptions = {},
): PageResult<StoredResultOverviewData> {
	const payload = unwrapStoredPayload(context.value);
	const kind = detectStoredResultKind(payload.value);
	const sources = collectSourceDetails(payload.value, kind);
	const sourcePage = pageItems(sources, {
		cursor: options.cursor,
		limit: options.limit,
		defaultLimit: OVERVIEW_SOURCE_LIMIT,
		maxLimit: OVERVIEW_SOURCE_LIMIT_MAX,
	});
	if (!sourcePage.ok) return sourcePage;
	const sourceNotes = sourcePage.value.items.map((source) => source.note);
	const findings = keyFindings(payload.value, kind);
	const summary = resultSummary(payload.value, kind, sources.length);
	const qualitySignals = buildQualitySignals(
		payload.value,
		kind,
		sources.length,
		findings,
		payload,
	);
	const pagination =
		sourcePage.value.hasMore || sourcePage.value.start > 0
			? { nextCursor: sourcePage.value.nextCursor, hasMore: sourcePage.value.hasMore }
			: undefined;
	const data: StoredResultOverviewData = {
		view: "overview",
		resultId: context.responseId,
		kind,
		query: resultQuery(payload.value),
		summary,
		answerContext: "",
		sourceNotes,
		qualitySignals,
		pagination,
		nextActions: overviewNextActions(context.responseId, sourceNotes, pagination),
		assistantGuidance: ASSISTANT_GUIDANCE,
		diagnostics: diagnostics(context, payload),
	};
	return {
		ok: true,
		value: { ...data, answerContext: formatOverviewAnswerContext(data, findings) },
	};
}

export function shapeStoredResultSource(
	context: StoredResultShapeContext,
	options: StoredResultPageOptions,
): PageResult<StoredResultSourceData> {
	if (!options.sourceId) {
		return shapeError("RESULT_SOURCE_ID_REQUIRED", "source", "view: source requires sourceId.");
	}
	const payload = unwrapStoredPayload(context.value);
	const kind = detectStoredResultKind(payload.value);
	const source = collectSourceDetails(payload.value, kind).find(
		(candidate) => candidate.note.id === options.sourceId,
	);
	if (!source) {
		return shapeError(
			"RESULT_SOURCE_NOT_FOUND",
			"source",
			`Stored result source not found: ${options.sourceId}`,
		);
	}
	const page = pageText(
		source.text || source.note.excerpt || "No stored source text is available.",
		{
			cursor: options.cursor,
			limit: options.limit,
			defaultLimit: SOURCE_TEXT_LIMIT,
			maxLimit: SOURCE_TEXT_LIMIT_MAX,
		},
	);
	if (!page.ok) return page;
	return {
		ok: true,
		value: {
			view: "source",
			resultId: context.responseId,
			kind,
			source: { ...source.note, citations: source.citations },
			sourceText: page.value.text,
			pagination: {
				nextCursor: page.value.nextCursor,
				hasMore: page.value.hasMore,
				start: page.value.start,
				end: page.value.end,
			},
			nextActions: sourceNextActions(context.responseId, source.note.id, page.value.nextCursor),
			assistantGuidance: ASSISTANT_GUIDANCE,
			diagnostics: diagnostics(context, payload),
		},
	};
}

export function shapeStoredResultRaw(
	context: StoredResultShapeContext,
	options: StoredResultPageOptions = {},
): PageResult<StoredResultRawData> {
	const payload = unwrapStoredPayload(context.value);
	const page = pageText(stringifyStoredValue(context.value), {
		cursor: options.cursor,
		limit: options.limit,
		defaultLimit: RAW_TEXT_LIMIT,
		maxLimit: RAW_TEXT_LIMIT_MAX,
	});
	if (!page.ok) return page;
	return {
		ok: true,
		value: {
			view: "raw",
			resultId: context.responseId,
			kind: detectStoredResultKind(payload.value),
			rawFormat: "json",
			rawText: page.value.text,
			pagination: {
				nextCursor: page.value.nextCursor,
				hasMore: page.value.hasMore,
				start: page.value.start,
				end: page.value.end,
			},
			nextActions: rawNextActions(context.responseId, page.value.nextCursor),
			assistantGuidance:
				"Raw view is diagnostic-heavy. Use it only for exact export/debug inspection; answer from overview/source views when possible.",
			diagnostics: diagnostics(context, payload),
		},
	};
}

export function formatStoredResultText(data: StoredResultGetData): string {
	if (data.view === "overview") return data.answerContext;
	if (data.view === "source") return formatSourceText(data);
	return formatRawText(data);
}

export function isStoredResultGetData(value: unknown): value is StoredResultGetData {
	if (!isRecord(value)) return false;
	return value.view === "overview" || value.view === "source" || value.view === "raw";
}

function formatSourceText(data: StoredResultSourceData): string {
	return [
		`Retrieved stored source ${data.source.id} from Gemini result: ${data.resultId}`,
		data.source.title ? `Title: ${data.source.title}` : undefined,
		data.source.uri ? `URI: ${data.source.uri}` : undefined,
		data.source.relevance ? `Relevance: ${data.source.relevance}` : undefined,
		"",
		"Source text page:",
		data.sourceText,
		data.pagination.hasMore && data.pagination.nextCursor
			? `Continuation: fetch next page with cursor ${data.pagination.nextCursor}.`
			: "Continuation: request raw JSON only if exact stored payload inspection is needed.",
	]
		.filter(Boolean)
		.join("\n");
}

function formatRawText(data: StoredResultRawData): string {
	return [
		`Retrieved raw diagnostic page from Gemini result: ${data.resultId}`,
		"Raw mode is diagnostic-heavy and usually unnecessary for answering.",
		"",
		"```json",
		data.rawText,
		"```",
		data.pagination.hasMore && data.pagination.nextCursor
			? `Continuation: fetch next raw page with cursor ${data.pagination.nextCursor}.`
			: undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function formatOverviewAnswerContext(data: StoredResultOverviewData, findings: string[]): string {
	const sourceLines = data.sourceNotes.flatMap((source, index) => [
		`${index + 1}. ${source.id} — ${source.title ?? "Untitled source"}${source.uri ? ` — ${source.uri}` : ""}`,
		source.excerpt ? `   ${source.excerpt}` : undefined,
		source.relevance ? `   Relevance: ${source.relevance}` : undefined,
	]);
	return [
		`Retrieved stored Gemini ${kindLabel(data.kind)} result: ${data.resultId}`,
		"",
		data.query ? `Query: ${data.query}` : undefined,
		`Summary: ${data.summary}`,
		"",
		findings.length > 0 ? "Key findings:" : undefined,
		...findings.map((finding) => `- ${finding}`),
		"",
		data.sourceNotes.length > 0 ? "Top sources:" : "Top sources: none stored in this result.",
		...sourceLines,
		"",
		`Quality: ${qualitySummary(data.qualitySignals)}`,
		`Continuation: ${continuationSummary(data)}`,
	]
		.filter(Boolean)
		.join("\n");
}

function overviewNextActions(
	responseId: string,
	sources: SourceNote[],
	pagination: StoredResultOverviewData["pagination"],
): NextAction[] {
	const actions: NextAction[] = sources.slice(0, 3).map((source) => ({
		action: "inspect_source",
		description: `Inspect stored source ${source.id}${source.title ? ` (${source.title})` : ""}.`,
		params: { action: "get", responseId, view: "source", sourceId: source.id },
	}));
	if (pagination?.nextCursor) {
		actions.push({
			action: "get_page",
			description: "Fetch the next page of stored source notes.",
			params: { action: "get", responseId, view: "overview", cursor: pagination.nextCursor },
		});
	}
	actions.push(rawAction(responseId));
	return actions;
}

function sourceNextActions(
	responseId: string,
	sourceId: string,
	nextCursor: string | undefined,
): NextAction[] {
	const actions: NextAction[] = [];
	if (nextCursor) {
		actions.push({
			action: "get_page",
			description: `Fetch the next text page for source ${sourceId}.`,
			params: { action: "get", responseId, view: "source", sourceId, cursor: nextCursor },
		});
	}
	actions.push(rawAction(responseId));
	return actions;
}

function rawNextActions(responseId: string, nextCursor: string | undefined): NextAction[] {
	if (!nextCursor) return [];
	return [
		{
			action: "get_page",
			description: "Fetch the next raw JSON diagnostic page.",
			params: { action: "get", responseId, view: "raw", cursor: nextCursor },
		},
	];
}

function rawAction(responseId: string): NextAction {
	return {
		action: "raw",
		description:
			"Inspect a bounded raw JSON diagnostic page only if exact payload details are needed.",
		params: { action: "get", responseId, view: "raw" },
	};
}

function diagnostics(
	context: StoredResultShapeContext,
	payload: PayloadView,
): StoredResultDiagnostics {
	return {
		responseId: context.responseId,
		fullOutputPath: context.fullOutputPath,
		originalTopLevelKeys: payload.originalTopLevelKeys,
	};
}

function shapeError<T>(code: string, phase: string, message: string): PageResult<T> {
	const error: StructuredError = { code, phase, message, retryable: false };
	return { ok: false, error };
}

function qualitySummary(signals: QualitySignals): string {
	const gaps = signals.knownGaps.length > 0 ? ` gaps: ${signals.knownGaps.join("; ")}` : "";
	const failures =
		signals.partialFailures.length > 0
			? ` partial failures: ${signals.partialFailures.join("; ")}`
			: "";
	return `confidence ${signals.confidence}; coverage ${signals.coverage}; freshness ${signals.freshness}.${gaps}${failures}`;
}

function continuationSummary(data: StoredResultOverviewData): string {
	const source = data.sourceNotes[0]?.id;
	const parts = [
		source ? `inspect source \`${source}\`` : undefined,
		data.pagination?.nextCursor ? "fetch next source page" : undefined,
		"request raw JSON if exact diagnostics are needed",
	].filter(Boolean);
	return parts.join(", ") + ".";
}

function kindLabel(kind: StoredResultKind): string {
	return kind === "unknown" ? "stored" : kind;
}

function stringifyStoredValue(value: unknown): string {
	// oxlint typescript/no-unnecessary-condition tracks TS types but JSON.stringify
	// returns string | undefined for undefined values; stored results are always defined.
	return JSON.stringify(value, null, 2) || "";
}
