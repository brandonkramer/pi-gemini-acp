/**
 * @file Shared Gemini tool rendering primitives, generic tool display factory, and prompt-style
 *   helpers.
 */
import type { Component } from "@earendil-works/pi-tui";

import type { PromptWorkflowUpdate } from "../prompt/run.ts";
import type { PiToolShell, ResultEnvelope, StructuredError } from "../types.ts";
import { isRecord } from "../utils/guards.ts";
import { truncateToolText } from "../utils/text.ts";
import type { ToolRenderResultOptions } from "./define.ts";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
} from "./gemini-rendering.ts";

/** Per-tool configuration that drives the generic formatToolDisplay factory. */
export interface ToolDisplaySpec<TProgress, TResult> {
	toolName: `gemini_${string}`;
	progress?: {
		test: (value: unknown) => boolean;
		extract: (data: unknown) => TProgress;
		collapsed: (progress: TProgress) => string;
		expanded: (progress: TProgress) => string;
	};
	result?: {
		test: (value: unknown) => boolean;
		extract: (data: unknown) => TResult;
		collapsed: (result: TResult) => string;
		expanded: (result: TResult, shell: PiToolShell) => string;
	};
	error?: {
		collapsed: (error: StructuredError) => string;
		expanded: (error: StructuredError) => string;
	};
	includeErrorInFallback?: boolean;
}

/** Generic tool display formatter that branches on progress, result, or error data. */
export function formatToolDisplay<TProgress, TResult>(
	result: PiToolShell,
	options: ToolRenderResultOptions,
	spec: ToolDisplaySpec<TProgress, TResult>,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;

	const progressSpec = spec.progress;
	if (progressSpec?.test(details.data)) {
		const progress = progressSpec.extract(details.data);
		return formatCollapsedOrExpanded(progress, options, {
			collapsed: progressSpec.collapsed,
			expanded: progressSpec.expanded,
		});
	}

	const resultSpec = spec.result;
	if (resultSpec?.test(details.data)) {
		const data = resultSpec.extract(details.data);
		return formatCollapsedOrExpanded(data, options, {
			collapsed: resultSpec.collapsed,
			expanded: (value) => resultSpec.expanded(value, result),
		});
	}

	if (details.error && spec.error) {
		return formatCollapsedOrExpanded(details.error, options, {
			collapsed: spec.error.collapsed,
			expanded: spec.error.expanded,
		});
	}

	return (
		result.content[0]?.text ??
		(spec.includeErrorInFallback ? details.error?.message : undefined) ??
		spec.toolName
	);
}

/** Tool-specific final-result formatters used by shared prompt-style rendering. */
export interface PromptToolDisplay<TData> {
	toolName: `gemini_${string}`;
	isData: (value: unknown) => value is TData;
	collapsed: (value: TData) => string;
	expanded: (value: TData, result: PiToolShell) => string;
}

/** Renders a prompt-style Gemini tool result or progress update in collapsed/expanded Pi UI. */
export function renderPromptToolResult<TData>(
	result: PiToolShell,
	options: ToolRenderResultOptions,
	theme: unknown,
	display: PromptToolDisplay<TData>,
): Component {
	const spec: ToolDisplaySpec<PromptWorkflowUpdate, TData> = {
		toolName: display.toolName,
		progress: {
			test: isPromptWorkflowUpdate,
			extract: (d) => d as PromptWorkflowUpdate,
			collapsed: formatPromptProgressCollapsed,
			expanded: (value) => formatPromptProgressExpanded(value, display.toolName),
		},
		result: {
			test: display.isData,
			extract: (d) => d as TData,
			collapsed: display.collapsed,
			expanded: display.expanded,
		},
		error: {
			collapsed: (error) => error.message,
			expanded: (error) =>
				[
					error.message,
					`code: ${error.code}`,
					error.phase ? `phase: ${error.phase}` : undefined,
					error.provider ? `provider: ${error.provider}` : undefined,
				]
					.filter(Boolean)
					.join("\n"),
		},
	};
	return boxedToolText(dimToolText(formatToolDisplay(result, options, spec), theme));
}

/** Formats shared prompt workflow progress and streaming chunks for Pi render modes. */
export function formatPromptWorkflowUpdate(
	update: PromptWorkflowUpdate,
	options: ToolRenderResultOptions,
	toolName: `gemini_${string}`,
): string {
	return formatCollapsedOrExpanded(update, options, {
		collapsed: formatPromptProgressCollapsed,
		expanded: (value) => formatPromptProgressExpanded(value, toolName),
	});
}

/** Formats responseId and storage metadata from a standard Pi tool shell. */
export function resultMetadataLines(result: PiToolShell): string[] {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	const lines: string[] = [];
	if (details.responseId) lines.push(`responseId: ${details.responseId}`);
	if (details.fullOutputPath) lines.push(`fullOutputPath: ${details.fullOutputPath}`);
	return lines;
}

/** Formats optional stored-output metadata from a workflow result. */
export function storedOutputLine(value: {
	responseId?: string;
	fullOutputPath?: string;
}): string | undefined {
	if (value.responseId && value.fullOutputPath) {
		return `responseId ${value.responseId}; stored at ${value.fullOutputPath}`;
	}
	if (value.responseId) return `responseId ${value.responseId}`;
	if (value.fullOutputPath) return `stored at ${value.fullOutputPath}`;
	return undefined;
}

/** Appends the shared Ctrl+O expansion hint to collapsed display lines. */
export function appendExpansionHint(lines: string[], details: string): string[] {
	return [...lines, expandedToolOutputHint(details)];
}

function formatPromptProgressCollapsed(update: PromptWorkflowUpdate): string {
	if (update.type === "chunk") {
		const latest = update.text.trim() || update.accumulatedText.trim();
		return `Receiving: ${truncateToolText(latest, 220)}`;
	}
	return update.text;
}

function formatPromptProgressExpanded(
	update: PromptWorkflowUpdate,
	toolName: `gemini_${string}`,
): string {
	if (update.type === "chunk") {
		return [
			`${toolName} chunk`,
			"latest chunk:",
			truncateToolText(update.text, 800),
			"accumulated preview:",
			truncateToolText(update.accumulatedText, 1_600),
		].join("\n");
	}
	return [`${toolName} ${update.phase}`, `message: ${update.text}`].join("\n");
}

/** Narrows unknown values to prompt workflow updates (chunk or progress). */
export function isPromptWorkflowUpdate(value: unknown): value is PromptWorkflowUpdate {
	return (
		isRecord(value) &&
		(value.type === "chunk"
			? typeof value.text === "string" && typeof value.accumulatedText === "string"
			: value.type === "progress" &&
				typeof value.phase === "string" &&
				typeof value.text === "string")
	);
}
