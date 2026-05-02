import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type CodeReviewOptions,
	type CodeReviewResult,
	runCodeReview,
} from "../prompt/code-review.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
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
				data: update,
				status: update.type === "chunk" ? "streaming" : "running",
			}),
		);
	};
}
