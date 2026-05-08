import type { Component } from "@earendil-works/pi-tui";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import type { ToolRenderResultOptions } from "./define.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	truncateToolText,
} from "./gemini-rendering.js";

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
	return boxedToolText(
		dimToolText(formatPromptToolDisplay(result, options, display), theme),
	);
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
	if (details.fullOutputPath)
		lines.push(`fullOutputPath: ${details.fullOutputPath}`);
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
export function appendExpansionHint(
	lines: string[],
	details: string,
): string[] {
	return [...lines, expandedToolOutputHint(details)];
}

function formatPromptToolDisplay<TData>(
	result: PiToolShell,
	options: ToolRenderResultOptions,
	display: PromptToolDisplay<TData>,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isPromptWorkflowUpdate(details.data)) {
		return formatPromptWorkflowUpdate(details.data, options, display.toolName);
	}
	if (display.isData(details.data)) {
		return formatCollapsedOrExpanded(details.data, options, {
			collapsed: display.collapsed,
			expanded: (value) => display.expanded(value, result),
		});
	}
	if (details.error) {
		return formatCollapsedOrExpanded(details.error, options, {
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
		});
	}
	return result.content[0]?.text ?? display.toolName;
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

export function isPromptWorkflowUpdate(
	value: unknown,
): value is PromptWorkflowUpdate {
	return (
		isRecord(value) &&
		(value.type === "chunk"
			? typeof value.text === "string" &&
				typeof value.accumulatedText === "string"
			: value.type === "progress" &&
				typeof value.phase === "string" &&
				typeof value.text === "string")
	);
}

/** Narrows unknown values to non-array records for tool display type guards. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
