import { storeResult } from "../storage/results.js";
import type { GeminiAcpConfig, StructuredError } from "../types.js";
import { directFetcher, type Fetcher } from "../url/fetcher.js";
import { assertPublicHttpUrl } from "../url/public-http.js";
import { providerError } from "./provider-result.js";
import {
	type PromptDeps,
	type PromptWorkflowUpdate,
	runPrompt,
} from "./run.js";

export const SUMMARY_SOURCE_DEFAULT_LIMIT = 20_000;
export const SUMMARY_SOURCE_MIN_LIMIT = 1_000;
export const SUMMARY_SOURCE_MAX_LIMIT = 50_000;

export type SummaryStyle = "paragraph" | "bullets" | "executive";

/** Inputs for a one-source Gemini ACP summarization run. */
export interface SummarizeOptions {
	content?: string;
	url?: string;
	title?: string;
	sentenceCount?: number;
	bulletCount?: number;
	audience?: string;
	style?: SummaryStyle;
	maxSourceCharacters?: number;
	config?: GeminiAcpConfig;
	rootDir?: string;
	cwd?: string;
}

/** Injectable summarization dependencies for ACP and safe direct-fetch tests. */
export interface SummarizeDeps extends PromptDeps {
	fetcher?: Fetcher;
}

/** Prepared one-source payload sent to Gemini ACP. */
export interface PreparedSummarySource {
	kind: "content" | "url";
	url?: string;
	title?: string;
	contentLength: number;
	preparedLength: number;
	truncated: boolean;
	maxSourceCharacters: number;
}

/** Final summary payload returned to tools. */
export interface SummarizeRunResult {
	provider: "gemini-acp";
	summary: string;
	summaryLength: number;
	summaryTruncated: boolean;
	source: PreparedSummarySource;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

export type SummarizeUpdateHandler = (
	update: PromptWorkflowUpdate,
) => void | Promise<void>;

/** Summarizes exactly one supplied content item or public HTTP(S) URL through Gemini ACP. */
export async function runSummarize(
	options: SummarizeOptions,
	deps: SummarizeDeps = {},
	signal?: AbortSignal,
	onUpdate?: SummarizeUpdateHandler,
): Promise<SummarizeRunResult> {
	const inputError = validateSummaryInput(options);
	if (inputError) return emptySummaryResult(inputError);

	const fetched = await loadSourceText(options, deps, signal, onUpdate);
	if (fetched.error) return emptySummaryResult(fetched.error);

	await onUpdate?.({
		type: "progress",
		phase: "source_prepare",
		text: "Preparing source text for summarization.",
	});
	const prepared = prepareSummarySource(fetched.text, options, fetched.url);
	if (prepared.source.truncated) {
		await onUpdate?.({
			type: "progress",
			phase: "source_prepare",
			text: `Source truncated from ${prepared.source.contentLength} to ${prepared.source.preparedLength} characters before summarization.`,
		});
	}

	const prompt = buildSummaryPrompt(options, prepared.source, prepared.text);
	const promptResult = await runPrompt(
		{
			...options,
			prompt,
			requestSummary: summaryRequestSummary(options, prepared.source),
		},
		deps,
		signal,
		onUpdate,
	);
	if (promptResult.error)
		return emptySummaryResult(promptResult.error, prepared.source);

	let responseId = promptResult.responseId;
	let fullOutputPath = promptResult.fullOutputPath;
	if (prepared.source.truncated && !responseId) {
		await onUpdate?.({
			type: "progress",
			phase: "store",
			text: "Storing truncated source-preparation metadata.",
		});
		const stored = await storeResult(
			{
				provider: "gemini-acp",
				summary: promptResult.text,
				source: prepared.source,
				preparedSource: prepared.text,
			},
			{ rootDir: options.rootDir },
		);
		responseId = stored.responseId;
		fullOutputPath = stored.path;
	} else if (responseId) {
		await onUpdate?.({
			type: "progress",
			phase: "store",
			text: "Stored large Gemini ACP summary output.",
		});
	}

	return {
		provider: "gemini-acp",
		summary: promptResult.text,
		summaryLength: promptResult.responseLength,
		summaryTruncated: promptResult.truncated,
		source: prepared.source,
		responseId,
		fullOutputPath,
	};
}

function validateSummaryInput(
	options: SummarizeOptions,
): StructuredError | undefined {
	const hasContent = Boolean(options.content?.trim());
	const hasUrl = Boolean(options.url?.trim());
	if (!hasContent && !hasUrl) {
		return summaryError(
			"GEMINI_SUMMARIZE_INPUT_REQUIRED",
			"input_validation",
			"Provide exactly one content string or URL to summarize.",
		);
	}
	if (hasContent && hasUrl) {
		return summaryError(
			"GEMINI_SUMMARIZE_SINGLE_SOURCE_REQUIRED",
			"input_validation",
			"gemini_summarize accepts one content item or one URL, not multiple sources.",
		);
	}
	return undefined;
}

async function loadSourceText(
	options: SummarizeOptions,
	deps: SummarizeDeps,
	signal: AbortSignal | undefined,
	onUpdate: SummarizeUpdateHandler | undefined,
): Promise<{ text: string; url?: string; error?: StructuredError }> {
	if (options.content?.trim()) return { text: options.content };
	let url: URL;
	try {
		url = assertPublicHttpUrl(options.url ?? "");
	} catch (cause) {
		return {
			text: "",
			error: {
				...summaryError(
					"GEMINI_SUMMARIZE_SOURCE_UNSAFE",
					"source_fetch",
					cause instanceof Error
						? cause.message
						: "Only safe public HTTP(S) URLs can be summarized.",
				),
				cause,
			},
		};
	}
	try {
		await onUpdate?.({
			type: "progress",
			phase: "source_fetch",
			text: `Fetching ${url.toString()} via safe direct fetch.`,
		});
		const fetched = await (deps.fetcher ?? directFetcher).fetch(url.toString(), {
			signal,
		});
		return { text: fetched.text, url: fetched.url };
	} catch (cause) {
		return {
			text: "",
			error: {
				...summaryError(
					"GEMINI_SUMMARIZE_SOURCE_FETCH_FAILED",
					"source_fetch",
					cause instanceof Error ? cause.message : "Source fetch failed.",
				),
				cause,
			},
		};
	}
}

function prepareSummarySource(
	text: string,
	options: SummarizeOptions,
	url?: string,
): { text: string; source: PreparedSummarySource } {
	const normalized = normalizeSourceText(text);
	const maxSourceCharacters = clampSourceLimit(options.maxSourceCharacters);
	const preparedText = normalized.slice(0, maxSourceCharacters);
	return {
		text: preparedText,
		source: {
			kind: url ? "url" : "content",
			url,
			title: options.title,
			contentLength: normalized.length,
			preparedLength: preparedText.length,
			truncated: normalized.length > preparedText.length,
			maxSourceCharacters,
		},
	};
}

function summaryRequestSummary(
	options: SummarizeOptions,
	source: PreparedSummarySource,
) {
	return {
		toolName: "gemini_summarize" as const,
		action: "Sending summarize prompt",
		subject: source.url ?? source.title ?? source.kind,
		arguments: {
			source: source.kind,
			style: summaryStyle(options),
			sentenceCount: options.sentenceCount,
			bulletCount: options.bulletCount,
			contentLength: source.contentLength,
			preparedLength: source.preparedLength,
			maxSourceCharacters: source.maxSourceCharacters,
			truncated: source.truncated,
		},
	};
}

function buildSummaryPrompt(
	options: SummarizeOptions,
	source: PreparedSummarySource,
	text: string,
): string {
	const style = summaryStyle(options);
	const instructions = [
		"Summarize exactly one supplied source. Do not perform web research or synthesize across multiple sources.",
		`Style: ${style}.`,
	];
	if (options.sentenceCount) {
		instructions.push(`Use about ${options.sentenceCount} sentence(s).`);
	}
	if (options.bulletCount) {
		instructions.push(`Use exactly ${options.bulletCount} concise bullet(s).`);
	}
	if (options.audience?.trim()) {
		instructions.push(`Audience: ${options.audience.trim()}.`);
	}
	if (source.truncated) {
		instructions.push(
			`The source was truncated from ${source.contentLength} to ${source.preparedLength} characters before summarization; mention this limitation briefly.`,
		);
	}
	const sourceLabel = source.url
		? `URL: ${source.url}`
		: source.title
			? `Title: ${source.title}`
			: "Content";
	return `${instructions.join("\n")}\n\n${sourceLabel}\n\nSOURCE:\n${text}`;
}

function summaryStyle(options: SummarizeOptions): SummaryStyle {
	return options.style ?? (options.bulletCount ? "bullets" : "paragraph");
}

function normalizeSourceText(text: string): string {
	return text
		.replace(/<script[\s\S]*?<\/script>/giu, " ")
		.replace(/<style[\s\S]*?<\/style>/giu, " ")
		.replace(/<[^>]+>/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function clampSourceLimit(value: number | undefined): number {
	if (!Number.isFinite(value)) return SUMMARY_SOURCE_DEFAULT_LIMIT;
	return Math.min(
		SUMMARY_SOURCE_MAX_LIMIT,
		Math.max(SUMMARY_SOURCE_MIN_LIMIT, Math.floor(value ?? 0)),
	);
}

function emptySummaryResult(
	error: StructuredError,
	source?: PreparedSummarySource,
): SummarizeRunResult {
	return {
		provider: "gemini-acp",
		summary: "",
		summaryLength: 0,
		summaryTruncated: false,
		source: source ?? {
			kind: "content",
			contentLength: 0,
			preparedLength: 0,
			truncated: false,
			maxSourceCharacters: SUMMARY_SOURCE_DEFAULT_LIMIT,
		},
		error,
	};
}

function summaryError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return providerError(code, phase, message, {
		retryable: false,
		provider: false,
	});
}
