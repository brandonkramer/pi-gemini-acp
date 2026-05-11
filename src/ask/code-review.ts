/** @file Internal code-review route used by the gemini_ask umbrella tool. */
import { type Static, Type } from "@earendil-works/pi-ai";

import {
	type CodeReviewOptions,
	type CodeReviewResult,
	runCodeReview,
} from "../prompt/code-review.ts";
import type { PromptWorkflowUpdate } from "../prompt/run.ts";
import { withToolResponseCache } from "../tools/cache.ts";
import { toolResultWithCost } from "../tools/cost-estimate.ts";
import type { ToolRenderResultOptions, ToolUpdate } from "../tools/define.ts";
import {
	formatToolDisplay,
	isPromptWorkflowUpdate,
	type ToolDisplaySpec,
} from "../tools/gemini-prompt-rendering.ts";
import { boxedToolText, dimToolText, expandedToolOutputHint } from "../tools/gemini-rendering.ts";
import { errorResult, toolResult } from "../tools/result.ts";
import type { PiToolShell } from "../types.ts";
import { isRecord } from "../utils/guards.ts";
import { truncateToolText } from "../utils/text.ts";

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

const askCodeReviewParamsSchema = Type.Object({
	diff: Type.Optional(
		Type.String({
			description: "Unified diff/patch text; paths are not read.",
		}),
	),
	code: Type.Optional(Type.String({ description: "Code/excerpt text; no fixes applied." })),
	context: Type.Optional(Type.String({ description: "Extra review context; avoid secrets." })),
	language: Type.Optional(Type.String({ description: "Language hint." })),
	filename: Type.Optional(Type.String({ description: "Display filename/label." })),
	focus: Type.Optional(
		Type.Array(focusSchema, {
			description: "Review focus; defaults to correctness.",
		}),
	),
	severityThreshold: Type.Optional(severitySchema),
	maxFindings: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 50,
			description: "Max findings.",
		}),
	),
	bypassCache: Type.Optional(Type.Boolean({ description: "Skip response cache." })),
});

type Params = Static<typeof askCodeReviewParamsSchema>;

type CodeReviewProgressData = { progress: PromptWorkflowUpdate };

export const askCodeReviewRoute = {
	async execute(toolCallId: string, params: Params, signal: AbortSignal, onUpdate?: ToolUpdate) {
		return await withToolResponseCache({
			toolName: "gemini_code_review",
			inputs: params,
			bypassCache: params.bypassCache,
			execute: async () => {
				const result = await runCodeReview(
					params as CodeReviewOptions,
					{},
					signal,
					codeReviewToolUpdate(onUpdate),
				);
				if (result.error) return errorResult(result.error);
				const inputText = [params.diff ?? "", params.code ?? "", params.context ?? ""].join("\n");
				return toolResultWithCost(
					toolCallId,
					"gemini_ask",
					inputText,
					result.text,
					{},
					{
						text: resultText(result),
						data: result,
						responseId: result.responseId,
						fullOutputPath: result.fullOutputPath,
					},
				);
			},
		});
	},
	renderResult(result: PiToolShell, options: ToolRenderResultOptions, theme: unknown) {
		return boxedToolText(dimToolText(formatCodeReviewToolDisplay(result, options), theme));
	},
};

function resultText(result: CodeReviewResult): string {
	if (result.truncated) {
		return `Gemini ACP code review stored as responseId ${result.responseId ?? "(none)"}. Analysis-only preview:\n${result.text}`;
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

const codeReviewDisplaySpec: ToolDisplaySpec<PromptWorkflowUpdate, CodeReviewResult> = {
	toolName: "gemini_code_review",
	progress: {
		test: isCodeReviewProgressData,
		extract: (d) => (d as { progress: PromptWorkflowUpdate }).progress,
		collapsed: formatCodeReviewProgressCollapsed,
		expanded: formatCodeReviewProgressExpanded,
	},
	result: {
		test: isCodeReviewResult,
		extract: (d) => d as CodeReviewResult,
		collapsed: formatCodeReviewCollapsedDisplay,
		expanded: formatCodeReviewExpandedDisplay,
	},
	includeErrorInFallback: true,
};

function formatCodeReviewToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
	return formatToolDisplay(result, options, codeReviewDisplaySpec);
}

function formatCodeReviewProgressCollapsed(update: PromptWorkflowUpdate): string {
	if (update.type === "chunk") {
		return `Reviewing: ${truncateToolText(update.text.trim(), 220)}`;
	}
	return update.text;
}

function formatCodeReviewProgressExpanded(update: PromptWorkflowUpdate): string {
	if (update.type === "chunk") {
		return [
			"gemini_code_review streaming",
			"latest chunk:",
			truncateToolText(update.text, 800),
			"accumulated preview:",
			truncateToolText(update.accumulatedText, 1_200),
		].join("\n");
	}
	return ["gemini_code_review progress", `phase: ${update.phase}`, `message: ${update.text}`].join(
		"\n",
	);
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
	const lines = [
		resultText(result),
		"",
		"Details:",
		`provider: ${result.provider}`,
		`responseLength: ${result.responseLength}`,
		`truncated: ${result.truncated}`,
		`sections: ${result.sections.join(", ")}`,
		...(result.responseId ? [`responseId: ${result.responseId}`] : []),
		...(result.fullOutputPath ? [`fullOutputPath: ${result.fullOutputPath}`] : []),
	];
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
		const heading = line.match(/^##\s+(.+?)\s*$/u);
		if (heading) {
			if (inSection) break;
			inSection = heading[1] === section;
			continue;
		}
		if (inSection && /^\s*-\s+/u.test(line) && !/none found\.?/iu.test(line)) {
			count += 1;
		}
	}
	return count;
}

function isCodeReviewProgressData(value: unknown): value is CodeReviewProgressData {
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
