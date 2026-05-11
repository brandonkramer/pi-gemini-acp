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
import { isRecord } from "../utils/guards.ts";
import { truncateToolText } from "../utils/text.ts";

const resultsGetParamsSchema = Type.Object({
	responseId: Type.String({ description: "Stored result responseId." }),
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
		try {
			const stored = await getStoredResult(params.responseId);
			return toolResult({
				text: `Retrieved result ${params.responseId}.`,
				data: stored.value,
				responseId: params.responseId,
				fullOutputPath: stored.path,
			});
		} catch {
			return errorResult({
				code: "RESULT_NOT_FOUND",
				phase: "storage",
				message: `Result not found: ${params.responseId}`,
				retryable: false,
			});
		}
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
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	const responseId = details.responseId ?? "unknown";
	return [
		`Retrieved stored Gemini result: ${responseId}`,
		storedValueSummary(details.data),
		expandedToolOutputHint("stored result JSON and path"),
	]
		.filter(Boolean)
		.join("\n");
}

function formatGetResultExpanded(result: PiToolShell): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	return [
		result.content[0]?.text,
		details.responseId ? `responseId: ${details.responseId}` : undefined,
		details.fullOutputPath ? `fullOutputPath: ${details.fullOutputPath}` : undefined,
		"Stored result preview:",
		truncateToolText(JSON.stringify(details.data, null, 2), 4_000),
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

function storedValueSummary(value: unknown): string | undefined {
	if (isRecord(value)) {
		const keys = Object.keys(value).slice(0, 6);
		return keys.length > 0 ? `top-level keys: ${keys.join(", ")}` : undefined;
	}
	if (typeof value === "string") return truncateToolText(value, 180);
	return value === undefined ? undefined : typeof value;
}
