/**
 * @fileoverview Aggregate Gemini ACP text task tool for prompt, extract, summarize, translate, and code review workflows.
 */
import { type Static, Type } from "@mariozechner/pi-ai";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { askCodeReviewRoute } from "../ask/code-review.js";
import { askExtractRoute } from "../ask/extract.js";
import { askPromptRoute } from "../ask/prompt.js";
import { askSummarizeRoute } from "../ask/summarize.js";
import { askTranslateRoute } from "../ask/translate.js";
import { defineGeminiTool } from "./define.js";
import { renderGeminiToolCallTitle } from "./gemini-rendering.js";
import { errorResult } from "./result.js";

const ASK_TASK_VALUES = {
	prompt: "prompt",
	extract: "extract",
	summarize: "summarize",
	translate: "translate",
	code_review: "code_review",
} as const;

const FOCUS_VALUES = {
	correctness: "correctness",
	security: "security",
	performance: "performance",
	maintainability: "maintainability",
	tests: "tests",
	api: "api",
	documentation: "documentation",
} as const;

const SEVERITY_VALUES = {
	all: "all",
	important: "important",
	blockers: "blockers",
} as const;

const SUMMARY_STYLE_VALUES = {
	paragraph: "paragraph",
	bullets: "bullets",
	executive: "executive",
} as const;

const askTaskSchema = Type.Enum(ASK_TASK_VALUES);
const severitySchema = Type.Any();
const summaryStyleSchema = Type.Any();

export const geminiAskSchema = Type.Object({
	task: askTaskSchema,
	prompt: Type.Optional(Type.Any()),
	content: Type.Optional(Type.Any()),
	url: Type.Optional(Type.Any()),
	schema: Type.Optional(Type.Any()),
	text: Type.Optional(Type.Any()),
	batch: Type.Optional(Type.Any()),
	targetLanguage: Type.Optional(Type.Any()),
	sourceLanguage: Type.Optional(Type.Any()),
	tone: Type.Optional(Type.Any()),
	glossary: Type.Optional(Type.Any()),
	preserve: Type.Optional(Type.Any()),
	preservationRules: Type.Optional(Type.Any()),
	diff: Type.Optional(Type.Any()),
	code: Type.Optional(Type.Any()),
	context: Type.Optional(Type.Any()),
	language: Type.Optional(Type.Any()),
	filename: Type.Optional(Type.Any()),
	focus: Type.Optional(Type.Any()),
	severityThreshold: Type.Optional(severitySchema),
	maxFindings: Type.Optional(Type.Any()),
	sentenceCount: Type.Optional(Type.Any()),
	bulletCount: Type.Optional(Type.Any()),
	audience: Type.Optional(Type.Any()),
	style: Type.Optional(summaryStyleSchema),
	maxSourceCharacters: Type.Optional(Type.Any()),
	useCache: Type.Optional(Type.Any()),
	bypassCache: Type.Optional(Type.Any()),
});

type Params = Static<typeof geminiAskSchema>;

export const geminiAskTool = defineGeminiTool({
	name: "gemini_ask",
	label: "Gemini Ask",
	description: "Text/URL tasks;cache;no files/secrets",
	parameters: geminiAskSchema,
	execute(toolCallId, params: Params, signal, onUpdate) {
		const validationError = validateAskTaskOptions(params);
		if (validationError) return Promise.resolve(validationError);

		switch (params.task) {
			case "prompt":
				return askPromptRoute.execute(
					toolCallId,
					{
						prompt: params.prompt ?? params.content ?? "",
						useCache: params.useCache,
						bypassCache: params.bypassCache,
					},
					signal,
					onUpdate,
				);
			case "extract":
				return askExtractRoute.execute(
					toolCallId,
					{
						content: params.content ?? "",
						prompt: params.prompt ?? "Extract structured data.",
						schema: params.schema,
						bypassCache: params.bypassCache,
					},
					signal,
					onUpdate,
				);
			case "summarize":
				return askSummarizeRoute.execute(
					toolCallId,
					params as Parameters<typeof askSummarizeRoute.execute>[1],
					signal,
					onUpdate,
				);
			case "translate":
				return askTranslateRoute.execute(
					toolCallId,
					{
						...params,
						targetLanguage: params.targetLanguage ?? "",
					} as Parameters<typeof askTranslateRoute.execute>[1],
					signal,
					onUpdate,
				);
			case "code_review":
				return askCodeReviewRoute.execute(
					toolCallId,
					params as Parameters<typeof askCodeReviewRoute.execute>[1],
					signal,
					onUpdate,
				);
		}
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_ask",
			stateKey: "geminiAskTitle",
		});
	},
	renderResult(result, options, theme) {
		return askRenderTarget(result).renderResult(result, options, theme);
	},
});

function validateAskTaskOptions(params: Params): PiToolShell | undefined {
	if (params.task === "prompt" || params.task === "extract") {
		const textError =
			validateStringOption("prompt", params.prompt) ??
			validateStringOption("content", params.content);
		if (textError) return textError;
	}

	const cacheError =
		validateBooleanOption("useCache", params.useCache) ??
		validateBooleanOption("bypassCache", params.bypassCache);
	if (cacheError) return cacheError;

	if (params.task === "summarize") {
		if (params.style && !isAllowedValue(params.style, SUMMARY_STYLE_VALUES)) {
			return invalidAskValue("style", params.style, SUMMARY_STYLE_VALUES);
		}
		const stringError =
			validateStringOption("content", params.content) ??
			validateStringOption("url", params.url) ??
			validateStringOption("audience", params.audience);
		if (stringError) return stringError;
		const numberError = validateNumberOption(
			"maxSourceCharacters",
			params.maxSourceCharacters,
		);
		if (numberError) return numberError;
		const countError =
			validateSummaryCount("sentenceCount", params.sentenceCount) ??
			validateSummaryCount("bulletCount", params.bulletCount);
		if (countError) return countError;
	}
	if (params.task === "translate") {
		const stringError =
			validateStringOption("text", params.text) ??
			validateStringOption("targetLanguage", params.targetLanguage) ??
			validateStringOption("sourceLanguage", params.sourceLanguage) ??
			validateStringOption("tone", params.tone);
		if (stringError) return stringError;
		const translateShapeError = validateTranslateShape(params);
		if (translateShapeError) return translateShapeError;
	}
	if (
		params.task === "code_review" &&
		params.severityThreshold &&
		!isAllowedValue(params.severityThreshold, SEVERITY_VALUES)
	) {
		return invalidAskValue(
			"severityThreshold",
			params.severityThreshold,
			SEVERITY_VALUES,
		);
	}
	if (params.task === "code_review") {
		const stringError =
			validateStringOption("diff", params.diff) ??
			validateStringOption("code", params.code) ??
			validateStringOption("context", params.context) ??
			validateStringOption("language", params.language) ??
			validateStringOption("filename", params.filename);
		if (stringError) return stringError;
		const numberError = validateNumberOption("maxFindings", params.maxFindings);
		if (numberError) return numberError;
	}
	if (params.task === "code_review" && params.focus !== undefined) {
		if (!Array.isArray(params.focus)) {
			return invalidAskShape("focus must be an array.");
		}
		const invalidFocus = params.focus.find(
			(value: unknown) => !isAllowedValue(value, FOCUS_VALUES),
		);
		if (invalidFocus)
			return invalidAskValue("focus", invalidFocus, FOCUS_VALUES);
	}
	return undefined;
}

function validateSummaryCount(
	name: "sentenceCount" | "bulletCount",
	value: unknown,
): PiToolShell | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && value >= 1 && value <= 20) return undefined;
	return errorResult({
		code: "GEMINI_ASK_INVALID_PARAMETER",
		phase: "input_validation",
		message: `Invalid ${name} for gemini_ask: ${value}. Allowed range: 1 to 20.`,
		retryable: false,
		provider: "gemini-acp",
	});
}

function validateNumberOption(
	name: "maxFindings" | "maxSourceCharacters",
	value: unknown,
): PiToolShell | undefined {
	if (value === undefined || typeof value === "number") return undefined;
	return errorResult({
		code: "GEMINI_ASK_INVALID_PARAMETER",
		phase: "input_validation",
		message: `Invalid ${name} for gemini_ask: ${value}. Expected a number.`,
		retryable: false,
		provider: "gemini-acp",
	});
}

function validateStringOption(
	name:
		| "prompt"
		| "content"
		| "text"
		| "url"
		| "diff"
		| "code"
		| "audience"
		| "targetLanguage"
		| "sourceLanguage"
		| "tone"
		| "context"
		| "language"
		| "filename",
	value: unknown,
): PiToolShell | undefined {
	if (value === undefined || typeof value === "string") return undefined;
	return errorResult({
		code: "GEMINI_ASK_INVALID_PARAMETER",
		phase: "input_validation",
		message: `Invalid ${name} for gemini_ask: ${value}. Expected text.`,
		retryable: false,
		provider: "gemini-acp",
	});
}

function validateBooleanOption(
	name: "useCache" | "bypassCache",
	value: unknown,
): PiToolShell | undefined {
	if (value === undefined || typeof value === "boolean") return undefined;
	return errorResult({
		code: "GEMINI_ASK_INVALID_PARAMETER",
		phase: "input_validation",
		message: `Invalid ${name} for gemini_ask: ${value}. Expected a boolean.`,
		retryable: false,
		provider: "gemini-acp",
	});
}

function validateTranslateShape(params: Params): PiToolShell | undefined {
	if (params.batch !== undefined && !Array.isArray(params.batch)) {
		return translateShapeError("Batch must be an array.");
	}
	if (
		params.batch?.some(
			(item: unknown) => !isRecord(item) || !isNonEmptyString(item.text),
		)
	) {
		return translateShapeError("Every batch item must include non-empty text.");
	}
	if (params.glossary !== undefined && !Array.isArray(params.glossary)) {
		return translateShapeError("Glossary must be an array.");
	}
	if (
		params.glossary?.some(
			(entry: unknown) =>
				!isRecord(entry) ||
				!isNonEmptyString(entry.source) ||
				!isNonEmptyString(entry.target),
		)
	) {
		return translateShapeError(
			"Every glossary entry must include source and target text.",
		);
	}
	if (params.preserve !== undefined && !Array.isArray(params.preserve)) {
		return translateShapeError("Preserve must be an array.");
	}
	if (params.preserve?.some((value: unknown) => typeof value !== "string")) {
		return translateShapeError("Every preserve item must be text.");
	}
	if (
		params.preservationRules !== undefined &&
		!Array.isArray(params.preservationRules)
	) {
		return translateShapeError("Preservation rules must be an array.");
	}
	if (
		params.preservationRules?.some(
			(value: unknown) => typeof value !== "string",
		)
	) {
		return translateShapeError("Every preservation rule must be text.");
	}
	return undefined;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function translateShapeError(message: string): PiToolShell {
	return errorResult({
		code: "GEMINI_ASK_INVALID_PARAMETER",
		phase: "input_validation",
		message,
		retryable: false,
		provider: "gemini-acp",
	});
}

function isAllowedValue(
	value: unknown,
	allowed: Record<string, string>,
): boolean {
	return typeof value === "string" && Object.values(allowed).includes(value);
}

function invalidAskShape(message: string): PiToolShell {
	return errorResult({
		code: "GEMINI_ASK_INVALID_PARAMETER",
		phase: "input_validation",
		message,
		retryable: false,
		provider: "gemini-acp",
	});
}

function invalidAskValue(
	name: string,
	value: unknown,
	allowed: Record<string, string>,
): PiToolShell {
	const allowedValues = Object.values(allowed).join(", ");
	return errorResult({
		code: "GEMINI_ASK_INVALID_PARAMETER",
		phase: "input_validation",
		message: `Invalid ${name} for gemini_ask: ${value}. Allowed: ${allowedValues}.`,
		retryable: false,
		provider: "gemini-acp",
	});
}

function askRenderTarget(result: PiToolShell) {
	const data = (result.details as Partial<ResultEnvelope<unknown>>).data;
	const record = data && typeof data === "object" ? data : {};
	if ("findings" in record || "sections" in record) return askCodeReviewRoute;
	if (
		"targetLanguage" in record ||
		"translations" in record ||
		"items" in record
	)
		return askTranslateRoute;
	if ("source" in record && "summary" in record) return askSummarizeRoute;
	if ("extracted" in record) return askExtractRoute;
	return askPromptRoute;
}
