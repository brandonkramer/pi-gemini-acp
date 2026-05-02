import { storeResult } from "../storage/results.js";
import type { GeminiAcpConfig, StructuredError } from "../types.js";
import {
	normalizeExtractMetadata,
	parseExtractionPayload,
} from "./extract-json.js";
import {
	validateExtractionSchema,
	validateValueAgainstSchema,
} from "./extract-schema.js";
import { type PromptDeps, type PromptUpdateHandler, runPrompt } from "./run.js";

const EXTRACT_RAW_STORAGE_LIMIT = 4_000;

/** Inputs for Gemini-backed structured extraction over supplied content. */
export interface ExtractOptions {
	content: string;
	prompt: string;
	schema: unknown;
	config?: GeminiAcpConfig;
	rootDir?: string;
	cwd?: string;
}

/** Normalized provider metadata when the model surfaces camelCase or snake_case fields. */
export interface ExtractProviderMetadata {
	provider?: string;
	model?: string;
	modelName?: string;
	responseId?: string;
	raw: unknown;
}

/** Structured extraction result returned by gemini_extract. */
export interface ExtractRunResult {
	provider: "gemini-acp";
	extracted: unknown;
	rawText: string;
	responseLength: number;
	truncated: boolean;
	responseId?: string;
	fullOutputPath?: string;
	metadata?: ExtractProviderMetadata;
	error?: StructuredError;
}

/** Executes a JSON-only extraction prompt through the shared Gemini ACP prompt workflow. */
export async function runExtract(
	options: ExtractOptions,
	deps: PromptDeps = {},
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<ExtractRunResult> {
	const inputError = validateExtractInputs(options);
	if (inputError) return emptyExtractResult(inputError);

	const schemaError = validateExtractionSchema(options.schema);
	if (schemaError) return emptyExtractResult(schemaError);

	const promptResult = await runPrompt(
		{
			...options,
			prompt: buildExtractionPrompt(options),
			inlineLimit: Number.POSITIVE_INFINITY,
		},
		deps,
		signal,
		onUpdate,
	);
	if (promptResult.error) return emptyExtractResult(promptResult.error);

	const parsed = parseExtractionPayload(promptResult.text);
	if (!parsed.ok) {
		return await rawOutputError(
			promptResult.text,
			options,
			"GEMINI_EXTRACT_INVALID_JSON",
			"response_parse",
			parsed.message,
		);
	}

	const mismatch = validateValueAgainstSchema(parsed.value, options.schema);
	if (mismatch) {
		return await rawOutputError(
			promptResult.text,
			options,
			"GEMINI_EXTRACT_SCHEMA_MISMATCH",
			"schema_validation",
			mismatch,
		);
	}

	const stored =
		promptResult.text.length > EXTRACT_RAW_STORAGE_LIMIT
			? await storeRawExtraction(promptResult.text, options)
			: undefined;
	return {
		provider: "gemini-acp",
		extracted: parsed.value,
		rawText: compactRawText(promptResult.text, Boolean(stored)),
		responseLength: promptResult.text.length,
		truncated: Boolean(stored),
		responseId: stored?.responseId,
		fullOutputPath: stored?.path,
		metadata: normalizeExtractMetadata(parsed.value),
	};
}

function buildExtractionPrompt(options: ExtractOptions): string {
	return [
		"Extract structured data from the supplied content.",
		"Return JSON only. Do not include Markdown fences, commentary, or explanations.",
		"The JSON must validate against this supported JSON-schema-like shape:",
		JSON.stringify(options.schema, null, 2),
		"Extraction instructions:",
		options.prompt.trim(),
		"Content:",
		options.content,
	].join("\n");
}

function validateExtractInputs(
	options: ExtractOptions,
): StructuredError | undefined {
	if (!options.prompt.trim()) {
		return extractError(
			"GEMINI_EXTRACT_EMPTY_PROMPT",
			"input_validation",
			"Extraction instructions are required.",
		);
	}
	if (!options.content.trim()) {
		return extractError(
			"GEMINI_EXTRACT_EMPTY_CONTENT",
			"input_validation",
			"Content to extract from is required.",
		);
	}
	return undefined;
}

async function rawOutputError(
	rawText: string,
	options: ExtractOptions,
	code: string,
	phase: string,
	message: string,
): Promise<ExtractRunResult> {
	const stored = await storeRawExtraction(rawText, options, {
		code,
		phase,
		message,
	});
	return {
		...emptyExtractResult(extractError(code, phase, message)),
		rawText: compactRawText(
			rawText,
			rawText.length > EXTRACT_RAW_STORAGE_LIMIT,
		),
		responseLength: rawText.length,
		truncated: rawText.length > EXTRACT_RAW_STORAGE_LIMIT,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

function compactRawText(rawText: string, shouldCompact: boolean): string {
	return shouldCompact
		? `${rawText.slice(0, EXTRACT_RAW_STORAGE_LIMIT)}…`
		: rawText;
}

async function storeRawExtraction(
	rawText: string,
	options: ExtractOptions,
	error?: { code: string; phase: string; message: string },
): Promise<{ responseId: string; path: string }> {
	return await storeResult(
		{
			provider: "gemini-acp",
			tool: "gemini_extract",
			instructions: options.prompt,
			schema: options.schema,
			rawText,
			error,
		},
		{ rootDir: options.rootDir },
	);
}

function emptyExtractResult(error?: StructuredError): ExtractRunResult {
	return {
		provider: "gemini-acp",
		extracted: undefined,
		rawText: "",
		responseLength: 0,
		truncated: false,
		error,
	};
}

function extractError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}
