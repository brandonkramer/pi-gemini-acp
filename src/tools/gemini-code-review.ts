import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type CodeReviewOptions,
	type CodeReviewResult,
	runCodeReview,
} from "../prompt/code-review.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import {
	defineGeminiTool,
	type ToolRenderResultOptions,
	type ToolUpdate,
} from "./define.js";
import { isPromptWorkflowUpdate, isRecord } from "./gemini-prompt-rendering.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
import { errorResult, toolResult } from "./result.js";

const focusSchema = Type.Union([
	Type.Literal("correctness"),
	Type.Literal("security"),
	Type.Literal("performance"),
	Type.Literal("maintainability"),
	Type.Literal("tests"),
	Type.Literal("api"),
	Type.Literal("documentation"),
]);

const severitySchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("important"),
	Type.Literal("blockers"),
]);

export const geminiAcpCodeReviewSchema = Type.Object({
	diff: Type.Optional(
		Type.String({
			description:
				"Unified diff or patch text to review. This tool does not read file paths.",
		}),
	),
	code: Type.Optional(
		Type.String({
			description:
				"Code or excerpt text to review. This tool does not apply fixes.",
		}),
	),
	context: Type.Optional(
		Type.String({
			description:
				"Additional caller-supplied project or review context. Avoid secrets.",
		}),
	),
	language: Type.Optional(Type.String({ description: "Language hint." })),
	filename: Type.Optional(
		Type.String({ description: "Optional display filename or path label." }),
	),
	focus: Type.Optional(
		Type.Array(focusSchema, {
			description: "Review focus areas. Defaults to correctness when omitted.",
		}),
	),
	severityThreshold: Type.Optional(severitySchema),
	maxFindings: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 50,
			description: "Maximum number of findings to request.",
		}),
	),
});

type Params = Static<typeof geminiAcpCodeReviewSchema>;

type CodeReviewProgressData = { progress: PromptWorkflowUpdate };

const CODE_REVIEW_TITLE_STATE_KEY = "geminiCodeReviewTitle";

export const geminiAcpCodeReviewTool = defineGeminiTool({
	name: "gemini_code_review",
	label: "Gemini ACP Code Review",
	description:
		"Analyze caller-provided code, diffs, or excerpts with Gemini ACP. Analysis-only: it does not read paths, edit files, or apply fixes.",
	parameters: geminiAcpCodeReviewSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		const result = await runCodeReview(
			params as CodeReviewOptions,
			{},
			signal,
			codeReviewToolUpdate(onUpdate),
		);
		if (result.error) return errorResult(result.error);
		return toolResult({
			text: resultText(result),
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_code_review",
			stateKey: CODE_REVIEW_TITLE_STATE_KEY,
		});
	},
	renderResult(result, options, theme) {
		return boxedToolText(
			dimToolText(formatCodeReviewToolDisplay(result, options), theme),
		);
	},
});

function resultText(result: CodeReviewResult): string {
	if (result.truncated) {
		return `Gemini ACP code review stored as responseId ${result.responseId}. Analysis-only preview:\n${result.text}`;
	}
	return `Gemini ACP code review (analysis only):\n${result.text}`;
}

function codeReviewToolUpdate(
	onUpdate: ToolUpdate | undefined,
): ((update: PromptWorkflowUpdate) => Promise<void>) | undefined {
	if (!onUpdate) return undefined;
	return async (update) => {
		await onUpdate(
			toolResult({
				text: update.text,
				data: { progress: update },
				status: update.type === "chunk" ? "streaming" : "running",
			}),
		);
	};
}

function formatCodeReviewToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isCodeReviewProgressData(details.data)) {
		return formatCollapsedOrExpanded(details.data.progress, options, {
			collapsed: formatCodeReviewProgressCollapsed,
			expanded: formatCodeReviewProgressExpanded,
		});
	}
	if (isCodeReviewResult(details.data)) {
		return formatCollapsedOrExpanded(details.data, options, {
			collapsed: formatCodeReviewCollapsedDisplay,
			expanded: formatCodeReviewExpandedDisplay,
		});
	}
	return (
		result.content[0]?.text ?? details.error?.message ?? "gemini_code_review"
	);
}

function formatCodeReviewProgressCollapsed(
	update: PromptWorkflowUpdate,
): string {
	if (update.type === "chunk") {
		return `Reviewing: ${truncateToolText(update.text.trim(), 220)}`;
	}
	return update.text;
}

function formatCodeReviewProgressExpanded(
	update: PromptWorkflowUpdate,
): string {
	if (update.type === "chunk") {
		return [
			"gemini_code_review streaming",
			"latest chunk:",
			truncateToolText(update.text, 800),
			"accumulated preview:",
			truncateToolText(update.accumulatedText, 1_200),
		].join("\n");
	}
	return [
		"gemini_code_review progress",
		`phase: ${update.phase}`,
		`message: ${update.text}`,
	].join("\n");
}

function formatCodeReviewCollapsedDisplay(result: CodeReviewResult): string {
	const counts = countCodeReviewFindings(result.text);
	const summary =
		counts.total === 0
			? "Gemini ACP code review found no findings."
			: `Gemini ACP code review found ${counts.total} finding(s): ${counts.blockers} blocker(s), ${counts.important} important, ${counts.optional} optional.`;
	return [
		summary,
		expandedToolOutputHint(
			"the full analysis, validation details, response ID, and storage details",
		),
	].join("\n");
}

function formatCodeReviewExpandedDisplay(result: CodeReviewResult): string {
	const lines = [resultText(result), "", "Details:"];
	lines.push(`provider: ${result.provider}`);
	lines.push(`responseLength: ${result.responseLength}`);
	lines.push(`truncated: ${result.truncated}`);
	lines.push(`sections: ${result.sections.join(", ")}`);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath)
		lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	return lines.join("\n");
}

function countCodeReviewFindings(text: string): {
	blockers: number;
	important: number;
	optional: number;
	total: number;
} {
	const blockers = countSectionFindings(text, "Blockers");
	const important = countSectionFindings(text, "Important");
	const optional = countSectionFindings(text, "Optional");
	return {
		blockers,
		important,
		optional,
		total: blockers + important + optional,
	};
}

function countSectionFindings(text: string, section: string): number {
	let inSection = false;
	let count = 0;
	for (const line of text.split("\n")) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			if (inSection) break;
			inSection = heading[1] === section;
			continue;
		}
		if (inSection && /^\s*-\s+/.test(line) && !/none found\.?/i.test(line)) {
			count += 1;
		}
	}
	return count;
}

function isCodeReviewProgressData(
	value: unknown,
): value is CodeReviewProgressData {
	return isRecord(value) && isPromptWorkflowUpdate(value.progress);
}

function isCodeReviewResult(value: unknown): value is CodeReviewResult {
	return (
		isRecord(value) &&
		value.provider === "gemini-acp" &&
		typeof value.text === "string" &&
		Array.isArray(value.sections)
	);
}
