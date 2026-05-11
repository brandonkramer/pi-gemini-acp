import type { GeminiAcpConfig, StructuredError } from "../types.ts";
import { providerError } from "./provider-result.ts";
import { type PromptDeps, type PromptUpdateHandler, runPrompt } from "./run.ts";

const MAX_TRANSLATION_ITEMS = 20;
const MAX_TRANSLATION_CHARS = 80_000;

/** One glossary entry that constrains Gemini ACP translation wording. */
export interface TranslateGlossaryEntry {
	source: string;
	target: string;
	note?: string;
}

/** One ordered batch item for Gemini ACP translation. */
export interface TranslateBatchItem {
	id?: string;
	text: string;
}

/** Inputs for deterministic Gemini ACP translation prompt construction. */
export interface TranslateOptions {
	text?: string;
	batch?: TranslateBatchItem[];
	targetLanguage: string;
	sourceLanguage?: string;
	tone?: string;
	glossary?: TranslateGlossaryEntry[];
	preserve?: string[];
	preservationRules?: string[];
	config?: GeminiAcpConfig;
	rootDir?: string;
	cwd?: string;
}

/** Parsed ordered batch translation item returned when Gemini emits valid JSON. */
export interface TranslateBatchResultItem {
	index: number;
	id?: string;
	translation: string;
	error?: string;
}

/** Gemini ACP translation result returned to public tool adapters. */
export interface TranslateRunResult {
	provider: "gemini-acp";
	mode: "single" | "batch";
	targetLanguage: string;
	sourceLanguage?: string;
	tone?: string;
	itemCount: number;
	text: string;
	translatedText?: string;
	items?: TranslateBatchResultItem[];
	responseLength: number;
	truncated: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

/** Builds and runs a translation prompt through configured/authenticated Gemini ACP only. */
export async function runTranslate(
	options: TranslateOptions,
	deps: PromptDeps = {},
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<TranslateRunResult> {
	const validationError = validateTranslateOptions(options);
	if (validationError) return emptyTranslateResult(options, validationError);

	const mode = options.batch ? "batch" : "single";
	const prompt = buildTranslatePrompt(options);
	const promptResult = await runPrompt(
		{
			prompt,
			config: options.config,
			rootDir: options.rootDir,
			cwd: options.cwd,
			useDefaultConfig: false,
			requestSummary: translateRequestSummary(options, mode),
		},
		deps,
		signal,
		onUpdate,
	);
	if (promptResult.error) return emptyTranslateResult(options, promptResult.error);

	const items =
		mode === "batch" && !promptResult.truncated
			? parseBatchTranslationOutput(promptResult.text, options.batch?.length ?? 0)
			: undefined;
	return {
		provider: "gemini-acp",
		mode,
		targetLanguage: options.targetLanguage.trim(),
		sourceLanguage: normalizedOptional(options.sourceLanguage),
		tone: normalizedOptional(options.tone),
		itemCount: mode === "batch" ? (options.batch?.length ?? 0) : 1,
		text: promptResult.text,
		translatedText: mode === "single" ? promptResult.text : undefined,
		items,
		responseLength: promptResult.responseLength,
		truncated: promptResult.truncated,
		responseId: promptResult.responseId,
		fullOutputPath: promptResult.fullOutputPath,
	};
}

/** Constructs the deterministic prompt used for Gemini ACP translation. */
export function buildTranslatePrompt(options: TranslateOptions): string {
	const mode = options.batch ? "batch" : "single";
	const lines = [
		"You are a precise translation and localization engine.",
		"Use configured glossary and preservation constraints exactly.",
		"Do not add explanations, apologies, or Markdown fences.",
		`Target language: ${options.targetLanguage.trim()}`,
		`Source language: ${normalizedOptional(options.sourceLanguage) ?? "auto-detect"}`,
		`Tone/register: ${normalizedOptional(options.tone) ?? "preserve source tone"}`,
		`Mode: ${mode}`,
		glossarySection(options.glossary),
		preserveSection(options.preserve),
		preservationRulesSection(options.preservationRules),
	];
	if (mode === "batch") {
		lines.push(
			"Batch output rules:",
			"1. Preserve input order and return exactly one JSON object per input item.",
			'2. Output JSON only with shape [{"index": number, "id": string, "translation": string, "error"?: string}].',
			"3. For a partial item failure, keep the item in order, set translation to an empty string, and include a brief error.",
			`Source payload JSON: ${JSON.stringify(batchPayload(options.batch ?? []))}`,
		);
	} else {
		lines.push(
			"Single output rules:",
			"1. Output only the translated text.",
			`Source text JSON: ${JSON.stringify({ text: options.text ?? "" })}`,
		);
	}
	return lines.join("\n");
}

function translateRequestSummary(options: TranslateOptions, mode: "single" | "batch") {
	const itemCount = mode === "batch" ? (options.batch?.length ?? 0) : 1;
	const totalChars =
		mode === "batch"
			? (options.batch ?? []).reduce((sum, item) => sum + item.text.length, 0)
			: (options.text?.length ?? 0);
	return {
		toolName: "gemini_translate" as const,
		action: "Sending translation prompt",
		subject: options.targetLanguage.trim(),
		arguments: {
			targetLanguage: options.targetLanguage.trim(),
			sourceLanguage: normalizedOptional(options.sourceLanguage) ?? "auto-detect",
			mode,
			itemCount,
			totalChars,
			glossaryTerms: normalizedGlossaryCount(options.glossary),
			preserveTerms: normalizedList(options.preserve).length,
			preservationRules: normalizedList(options.preservationRules).length,
			tone: normalizedOptional(options.tone),
		},
	};
}

function normalizedGlossaryCount(entries: TranslateGlossaryEntry[] | undefined): number {
	return (entries ?? []).filter((entry) => entry.source.trim() && entry.target.trim()).length;
}

function validateTranslateOptions(options: TranslateOptions): StructuredError | undefined {
	if (!options.targetLanguage?.trim()) {
		return translateError(
			"GEMINI_TRANSLATE_TARGET_REQUIRED",
			"input_validation",
			"Target language is required.",
		);
	}
	const hasText = Boolean(options.text?.trim());
	const hasBatch = Array.isArray(options.batch) && options.batch.length > 0;
	if (hasText === hasBatch) {
		return translateError(
			"GEMINI_TRANSLATE_INPUT_REQUIRED",
			"input_validation",
			"Provide exactly one of text or a non-empty batch.",
		);
	}
	if (options.batch && options.batch.length > MAX_TRANSLATION_ITEMS) {
		return translateError(
			"GEMINI_TRANSLATE_BATCH_TOO_LARGE",
			"input_validation",
			`Batch translation supports at most ${MAX_TRANSLATION_ITEMS} items.`,
		);
	}
	const totalChars = hasBatch
		? (options.batch ?? []).reduce((sum, item) => sum + item.text.length, 0)
		: (options.text?.length ?? 0);
	if (totalChars > MAX_TRANSLATION_CHARS) {
		return translateError(
			"GEMINI_TRANSLATE_INPUT_TOO_LARGE",
			"input_validation",
			`Translation input must be ${MAX_TRANSLATION_CHARS} characters or less.`,
		);
	}
	if (options.batch?.some((item) => !item.text.trim())) {
		return translateError(
			"GEMINI_TRANSLATE_EMPTY_BATCH_ITEM",
			"input_validation",
			"Every batch item must include non-empty text.",
		);
	}
	return undefined;
}

function parseBatchTranslationOutput(
	text: string,
	expectedLength: number,
): TranslateBatchResultItem[] | undefined {
	try {
		const parsed = JSON.parse(text.trim()) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== expectedLength) return undefined;
		const items = parsed.map((entry, position) => {
			const record = asRecord(entry);
			if (!record || record.index !== position) return undefined;
			const translation = record.translation;
			if (typeof translation !== "string") return undefined;
			return {
				index: position,
				id: typeof record.id === "string" ? record.id : undefined,
				translation,
				error: typeof record.error === "string" ? record.error : undefined,
			};
		});
		return items.every(Boolean) ? (items as TranslateBatchResultItem[]) : undefined;
	} catch {
		return undefined;
	}
}

function glossarySection(entries: TranslateGlossaryEntry[] | undefined): string {
	const normalized = (entries ?? [])
		.map((entry) => ({
			source: entry.source.trim(),
			target: entry.target.trim(),
			note: normalizedOptional(entry.note),
		}))
		.filter((entry) => entry.source && entry.target)
		.toSorted((a, b) =>
			`${a.source}\u0000${a.target}\u0000${a.note ?? ""}`.localeCompare(
				`${b.source}\u0000${b.target}\u0000${b.note ?? ""}`,
			),
		);
	if (normalized.length === 0) return "Glossary: none";
	return [
		"Glossary:",
		...normalized.map(
			(entry, index) =>
				`${index + 1}. ${JSON.stringify(entry.source)} => ${JSON.stringify(entry.target)}${entry.note ? ` (${entry.note})` : ""}`,
		),
	].join("\n");
}

function preserveSection(terms: string[] | undefined): string {
	const normalized = normalizedList(terms);
	if (normalized.length === 0) return "Preserve unchanged: none";
	return [
		"Preserve unchanged:",
		...normalized.map((term, index) => `${index + 1}. ${JSON.stringify(term)}`),
	].join("\n");
}

function preservationRulesSection(rules: string[] | undefined): string {
	const normalized = normalizedList(rules);
	if (normalized.length === 0) return "Preservation rules: none";
	return ["Preservation rules:", ...normalized.map((rule, index) => `${index + 1}. ${rule}`)].join(
		"\n",
	);
}

function normalizedList(values: string[] | undefined): string[] {
	return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].toSorted(
		(a, b) => a.localeCompare(b),
	);
}

function batchPayload(items: TranslateBatchItem[]): {
	items: Array<{ index: number; id?: string; text: string }>;
} {
	return {
		items: items.map((item, index) => ({
			index,
			id: normalizedOptional(item.id),
			text: item.text,
		})),
	};
}

function emptyTranslateResult(
	options: TranslateOptions,
	error: StructuredError,
): TranslateRunResult {
	return {
		provider: "gemini-acp",
		mode: options.batch ? "batch" : "single",
		targetLanguage: options.targetLanguage?.trim() ?? "",
		sourceLanguage: normalizedOptional(options.sourceLanguage),
		tone: normalizedOptional(options.tone),
		itemCount: options.batch ? options.batch.length : 1,
		text: "",
		responseLength: 0,
		truncated: false,
		error,
	};
}

function translateError(code: string, phase: string, message: string): StructuredError {
	return providerError(code, phase, message, { retryable: false });
}

function normalizedOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ?? undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
