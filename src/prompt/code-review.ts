import type { GeminiAcpConfig } from "../types.ts";
import { providerError } from "./provider-result.ts";
import type { PromptDeps, PromptRunResult, PromptUpdateHandler } from "./run.ts";
import { runPrompt } from "./run.ts";

const DEFAULT_MAX_FINDINGS = 12;

export const CODE_REVIEW_SECTIONS = ["Blockers", "Important", "Optional", "Validation"] as const;

export const CODE_REVIEW_FOCUS_AREAS = [
	"correctness",
	"security",
	"performance",
	"maintainability",
	"tests",
	"api",
	"documentation",
] as const;

export const CODE_REVIEW_SEVERITY_THRESHOLDS = ["all", "important", "blockers"] as const;

export type CodeReviewFocusArea = (typeof CODE_REVIEW_FOCUS_AREAS)[number];
export type CodeReviewSeverityThreshold = (typeof CODE_REVIEW_SEVERITY_THRESHOLDS)[number];

/** Inputs for Gemini-backed analysis-only code review over supplied text. */
export interface CodeReviewOptions {
	diff?: string;
	code?: string;
	context?: string;
	language?: string;
	filename?: string;
	focus?: CodeReviewFocusArea[];
	severityThreshold?: CodeReviewSeverityThreshold;
	maxFindings?: number;
	config?: GeminiAcpConfig;
	rootDir?: string;
	cwd?: string;
}

/** Code review result with the exact review prompt retained for tests/debugging. */
export interface CodeReviewResult extends PromptRunResult {
	prompt?: string;
	sections: typeof CODE_REVIEW_SECTIONS;
}

/** Builds the deterministic, analysis-only prompt used by gemini_code_review. */
export function buildCodeReviewPrompt(options: CodeReviewOptions): string {
	const diff = options.diff?.trim() ?? "";
	const code = options.code?.trim() ?? "";
	const context = options.context?.trim() ?? "";
	const focus = normalizeFocus(options.focus);
	const severityThreshold = options.severityThreshold ?? "all";
	const maxFindings = normalizeMaxFindings(options.maxFindings);
	const metadata = [
		options.filename?.trim() ? `Filename: ${options.filename.trim()}` : undefined,
		options.language?.trim() ? `Language: ${options.language.trim()}` : undefined,
	]
		.filter(Boolean)
		.join("\n");

	return [
		"You are Gemini performing an analysis-only code review for Pi.",
		"Do not edit files, produce patches, or claim that fixes were applied.",
		"Review only the caller-provided diff/code/context below; do not assume filesystem access or hidden project state.",
		"If evidence is insufficient, say so in the relevant section instead of inventing facts.",
		"",
		"Return Markdown with exactly these top-level headings, in this order:",
		...CODE_REVIEW_SECTIONS.map((section) => `## ${section}`),
		"",
		"Finding format: - [severity] concise title — evidence; impact; recommendation.",
		"Use 'None found.' under a section when there are no findings for it.",
		`Severity threshold: ${severityThreshold}. Still include every required heading even when a threshold suppresses findings.`,
		`Focus areas: ${focus.join(", ")}.`,
		`Maximum findings: ${maxFindings}. Prioritize the highest-impact issues first.`,
		"Validation should list concrete checks the caller can run or explain why no validation is inferable.",
		metadata ? `\nMetadata:\n${metadata}` : "",
		context ? `\nContext:\n<context>\n${context}\n</context>` : "",
		diff ? `\nDiff:\n<diff>\n${diff}\n</diff>` : "",
		code ? `\nCode:\n<code>\n${code}\n</code>` : "",
	]
		.filter((part) => part.length > 0)
		.join("\n");
}

/** Runs an analysis-only Gemini code review through the shared prompt workflow. */
export async function runCodeReview(
	options: CodeReviewOptions,
	deps: PromptDeps = {},
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<CodeReviewResult> {
	if (!hasReviewInput(options)) {
		return codeReviewError(
			"GEMINI_CODE_REVIEW_EMPTY_INPUT",
			"input_validation",
			"Provide diff or code text for gemini_code_review. File paths are not read by this tool.",
		);
	}

	const prompt = buildCodeReviewPrompt(options);
	const result = await runPrompt(
		{
			prompt,
			config: options.config,
			rootDir: options.rootDir,
			cwd: options.cwd,
			requestSummary: codeReviewRequestSummary(options),
		},
		deps,
		signal,
		onUpdate,
	);
	return { ...result, prompt, sections: CODE_REVIEW_SECTIONS };
}

function codeReviewRequestSummary(options: CodeReviewOptions) {
	const focus = normalizeFocus(options.focus);
	return {
		toolName: "gemini_code_review" as const,
		action: "Sending code review prompt",
		subject: options.filename?.trim() ?? options.language?.trim() ?? "provided text",
		arguments: {
			language: options.language?.trim() ?? undefined,
			filename: options.filename?.trim() ?? undefined,
			focus: focus.join("/"),
			severity: options.severityThreshold ?? "all",
			maxFindings: normalizeMaxFindings(options.maxFindings),
			diffLength: options.diff?.length,
			codeLength: options.code?.length,
			contextLength: options.context?.length,
		},
	};
}

function hasReviewInput(options: CodeReviewOptions): boolean {
	return Boolean(options.diff?.trim() ?? options.code?.trim());
}

function normalizeFocus(focus: CodeReviewFocusArea[] | undefined): CodeReviewFocusArea[] {
	return focus && focus.length > 0 ? [...new Set(focus)] : ["correctness"];
}

function normalizeMaxFindings(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_MAX_FINDINGS;
	}
	return Math.min(50, Math.max(1, Math.trunc(value)));
}

function codeReviewError(code: string, phase: string, message: string): CodeReviewResult {
	return {
		provider: "gemini-acp",
		text: "",
		responseLength: 0,
		truncated: false,
		sections: CODE_REVIEW_SECTIONS,
		error: providerError(code, phase, message),
	};
}
