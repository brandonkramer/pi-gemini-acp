/** @file Internal stored-result route used by the gemini_results umbrella tool. */
import { type Static, Type } from "@earendil-works/pi-ai";

import { getStoredResult } from "../storage/results.ts";
import type { ToolRenderResultOptions } from "../tools/define.ts";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
} from "../tools/gemini-rendering.ts";
import { errorResult, toolResult } from "../tools/result.ts";
import type { PiToolShell, ResultEnvelope, StructuredError } from "../types.ts";
import { truncateToolText } from "../utils/text.ts";
import type { QualitySignals, StoredResultGetData, StoredResultView } from "./shape-types.ts";
import {
	formatStoredResultText,
	isStoredResultGetData,
	shapeStoredResultOverview,
	shapeStoredResultRaw,
	shapeStoredResultSource,
	type StoredResultPageOptions,
	type StoredResultShapeContext,
} from "./shape.ts";

const resultsGetViewSchema = Type.Enum({ overview: "overview", source: "source", raw: "raw" });

const resultsGetParamsSchema = Type.Object({
	responseId: Type.String({ description: "Stored result responseId." }),
	view: Type.Optional(resultsGetViewSchema),
	sourceId: Type.Optional(Type.String({ description: "Stable source id for view: source." })),
	cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor." })),
	limit: Type.Optional(Type.Number({ minimum: 1 })),
});

type Params = Static<typeof resultsGetParamsSchema>;

export const resultsGetRoute = {
	async execute(
		_toolCallId: string,
		params: Params,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		_ctx?: unknown,
	) {
		let stored: Awaited<ReturnType<typeof getStoredResult>>;
		try {
			stored = await getStoredResult(params.responseId);
		} catch {
			return errorResult({
				code: "RESULT_NOT_FOUND",
				phase: "storage",
				message: `Result not found: ${params.responseId}`,
				retryable: false,
			});
		}
		const context = {
			responseId: params.responseId,
			fullOutputPath: stored.path,
			value: stored.value,
		};
		const view = normalizeStoredResultView(params.view);
		if (!view) {
			return errorResult(
				{
					code: "RESULT_VIEW_INVALID",
					phase: "input_validation",
					message: `Unsupported stored-result view: ${params.view ?? ""}`,
					retryable: false,
				},
				undefined,
				{ responseId: params.responseId, fullOutputPath: stored.path },
			);
		}
		const shaped = shapeStoredResultView(view, context, params);
		if (!shaped.ok) {
			return errorResult(shaped.error, shaped.error.message, {
				responseId: params.responseId,
				fullOutputPath: stored.path,
			});
		}
		return toolResult({
			text: formatStoredResultText(shaped.value),
			data: shaped.value,
			responseId: params.responseId,
			fullOutputPath: stored.path,
		});
	},
	renderResult(
		result: PiToolShell,
		options: ToolRenderResultOptions,
		theme: unknown,
		_context?: unknown,
	) {
		return boxedToolText(dimToolText(formatGetResultToolDisplay(result, options), theme));
	},
};

function formatGetResultToolDisplay(result: PiToolShell, options: ToolRenderResultOptions): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (details.error) return formatError(details.error, options);
	return formatCollapsedOrExpanded(result, options, {
		collapsed: formatGetResultCollapsed,
		expanded: formatGetResultExpanded,
	});
}

function formatGetResultCollapsed(result: PiToolShell): string {
	const data = renderableStoredResultData(result);
	if (data.view === "source") {
		return [
			`Retrieved stored source ${data.source.id}: ${data.source.title ?? data.resultId}`,
			truncateToolText(data.sourceText, 260),
			data.pagination.hasMore ? "more source text available" : undefined,
			expandedToolOutputHint("source details and continuation actions"),
		]
			.filter(Boolean)
			.join("\n");
	}
	if (data.view === "raw") {
		return [
			`Retrieved raw diagnostic page: ${data.resultId}`,
			"raw mode is usually unnecessary for answering",
			data.pagination.hasMore ? "more raw JSON available" : undefined,
			expandedToolOutputHint("bounded raw JSON and diagnostics"),
		]
			.filter(Boolean)
			.join("\n");
	}
	return [
		`Retrieved stored Gemini ${data.kind} result: ${data.resultId}`,
		data.summary,
		data.sourceNotes.length > 0 ? `sources: ${data.sourceNotes.length}` : "sources: none stored",
		`quality: ${formatQualitySignals(data.qualitySignals)}`,
		formatNextActions(data.nextActions),
		expandedToolOutputHint("source notes, continuation actions, and diagnostics"),
	]
		.filter(Boolean)
		.join("\n");
}

function formatGetResultExpanded(result: PiToolShell): string {
	const data = renderableStoredResultData(result);
	return [
		formatStoredResultText(data),
		"",
		"Next actions:",
		...data.nextActions.map((action) => `- ${action.action}: ${action.description}`),
		"",
		"Diagnostics:",
		`responseId: ${data.diagnostics.responseId}`,
		data.diagnostics.fullOutputPath
			? `fullOutputPath: ${data.diagnostics.fullOutputPath}`
			: undefined,
		data.diagnostics.originalTopLevelKeys.length > 0
			? `originalTopLevelKeys: ${data.diagnostics.originalTopLevelKeys.join(", ")}`
			: undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function formatError(error: StructuredError, options: ToolRenderResultOptions): string {
	return formatCollapsedOrExpanded(error, options, {
		collapsed: (value) => value.message,
		expanded: (value) =>
			[value.message, `code: ${value.code}`, value.phase ? `phase: ${value.phase}` : undefined]
				.filter(Boolean)
				.join("\n"),
	});
}

function normalizeStoredResultView(view: Params["view"]): StoredResultView | undefined {
	if (view === undefined || view === "overview") return "overview";
	if (view === "source" || view === "raw") return view;
	return undefined;
}

function shapeStoredResultView(
	view: StoredResultView,
	context: StoredResultShapeContext,
	options: StoredResultPageOptions,
) {
	if (view === "source") return shapeStoredResultSource(context, options);
	if (view === "raw") return shapeStoredResultRaw(context, options);
	return shapeStoredResultOverview(context, options);
}

function renderableStoredResultData(result: PiToolShell): StoredResultGetData {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isStoredResultGetData(details.data)) return details.data;
	const responseId = details.responseId ?? "unknown";
	const shaped = shapeStoredResultOverview({
		responseId,
		fullOutputPath: details.fullOutputPath,
		value: details.data,
	});
	return shaped.ok
		? shaped.value
		: {
				view: "overview",
				resultId: responseId,
				kind: "unknown",
				summary: "Stored result could not be shaped for display.",
				answerContext: shaped.error.message,
				sourceNotes: [],
				qualitySignals: {
					confidence: "unknown",
					coverage: "unknown",
					freshness: "unknown",
					knownGaps: [shaped.error.message],
					conflicts: [],
					partialFailures: [],
				},
				nextActions: [],
				assistantGuidance: "Use raw view only if this stored result must be debugged.",
				diagnostics: {
					responseId,
					fullOutputPath: details.fullOutputPath,
					originalTopLevelKeys: [],
				},
			};
}

function formatQualitySignals(signals: QualitySignals): string {
	return `${signals.confidence}/${signals.coverage}/${signals.freshness}`;
}

function formatNextActions(actions: StoredResultGetData["nextActions"]): string | undefined {
	if (actions.length === 0) return undefined;
	return `continuation: ${actions.map((action) => action.action).join(", ")}`;
}
