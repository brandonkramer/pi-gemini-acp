import { stat } from "node:fs/promises";
import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptChunk,
} from "../acp/client.js";
import { getCachedGeminiAcpClient } from "../acp/client-cache.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import type {
	GeminiAcpAuthProbe,
	StatusCommandChecker,
} from "../config/status.js";
import { isAbortError, providerError } from "../prompt/provider-result.js";
import {
	sourceTextForLexicalRecall,
	upsertLexicalRecallEntry,
} from "../recall/lexical-recall.js";
import {
	invalidateSearchPreflight,
	preflightSearchProvider,
} from "./preflight-cache.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import { storeResult } from "../storage/results.js";
import type {
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
	SearchResultItem,
	StructuredError,
} from "../types.js";
import { normalizeUrl } from "../url/normalize.js";

export {
	__resetGeminiSearchPreflightCache,
	primeSuccessfulGeminiSearchPreflight,
} from "./preflight-cache.js";

/** Checks whether an ACP command is available before provider search. */
export type CommandChecker = StatusCommandChecker;

/** Inputs accepted by local/no-key and Gemini ACP search workflows. */
export interface SearchOptions {
	query: string;
	maxResults?: number;
	config?: GeminiAcpConfig;
	rootDir?: string;
	localDocuments?: Array<{
		title?: string;
		url: string;
		text?: string;
		snippet?: string;
	}>;
}

/** Progress event emitted while search preflights, streams, stores, and completes. */
export interface SearchProgressUpdate {
	phase:
		| "local_search"
		| "provider_preflight"
		| "provider_warm"
		| "provider_session"
		| "provider_search"
		| "provider_stream"
		| "store_results"
		| "complete";
	message: string;
	query: string;
	provider?: "local" | "gemini-acp";
	model?: string;
	maxResults?: number;
	resultCount?: number;
	chunk?: GeminiAcpPromptChunk;
	responseId?: string;
}

/** Receives search progress updates for Pi tool streaming. */
export type SearchProgressHandler = (
	update: SearchProgressUpdate,
) => void | Promise<void>;

/** Injectable dependencies for tests and provider/runtime adapters. */
export interface SearchDeps {
	geminiAcpClient?: GeminiAcpClient;
	geminiAcpClientFactory?: (
		settings: GeminiAcpCommandSettings,
	) => GeminiAcpClient;
	commandExists?: CommandChecker;
	authProbe?: GeminiAcpAuthProbe;
	onProgress?: SearchProgressHandler;
}

/** Normalized search result envelope returned by runSearch. */
export interface SearchRunResult {
	provider: "local" | "gemini-acp";
	model?: string;
	results: SearchResultItem[];
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

const SEARCH_TERM_SPLIT_RE = /\s+/u;
const SEARCH_HAS_WHITESPACE_RE = /\s/u;

/** Runs local document search or preflighted Gemini ACP grounded search. */
export async function runSearch(
	options: SearchOptions,
	deps: SearchDeps = {},
	signal?: AbortSignal,
): Promise<SearchRunResult> {
	if (options.localDocuments?.length) {
		await emitProgress(deps.onProgress, {
			phase: "local_search",
			message: "Searching supplied local documents.",
			query: options.query,
			provider: "local",
		});
		return storeSearchResults(
			"local",
			localSearch(options.query, options.localDocuments),
			options.rootDir,
			options.query,
			deps.onProgress,
			undefined,
			true,
		);
	}

	const loadedConfig =
		options.config ??
		configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const config = withDefaultGeminiAcpConfig(loadedConfig);
	const settings = config.providers?.["gemini-acp"];
	const commandSettings = buildGeminiAcpCommandSettings(settings);
	const model = geminiAcpModelLabel(settings, commandSettings);
	await emitProgress(deps.onProgress, {
		phase: "provider_preflight",
		message: "Checking Gemini ACP command, auth, and search grounding.",
		query: options.query,
		provider: "gemini-acp",
		model,
	});
	const preflight = await preflightSearchProvider(
		settings,
		commandSettings,
		{
			commandExists: deps.commandExists,
			requireSearchGrounding: true,
			rootDir: options.rootDir,
			signal,
			authProbe: deps.authProbe,
			persistAuthConfirmation: options.config ? false : true,
		},
		options.config === undefined,
	);
	if (preflight)
		return { provider: "gemini-acp", model, results: [], error: preflight };

	const client =
		deps.geminiAcpClient ??
		(deps.geminiAcpClientFactory ?? getCachedGeminiAcpClient)(commandSettings);
	try {
		const maxResults = options.maxResults ?? 5;
		await emitProgress(deps.onProgress, {
			phase: "provider_search",
			message: `Sending search prompt: "${options.query}" with ${maxResults} max results via ${model}.`,
			query: options.query,
			provider: "gemini-acp",
			model,
			maxResults,
		});
		const results = await client.search(
			{
				query: options.query,
				maxResults,
				model,
				onProgress: (phase, message) => {
					const phaseMap: Record<string, SearchProgressUpdate["phase"]> = {
						warm: "provider_warm",
						session: "provider_session",
						search: "provider_search",
					};
					void emitProgress(deps.onProgress, {
						phase: phaseMap[phase] ?? "provider_search",
						message,
						query: options.query,
						provider: "gemini-acp",
						model,
						maxResults,
					});
				},
			},
			signal,
			async (chunk) => {
				await emitProgress(deps.onProgress, {
					phase: "provider_stream",
					message: chunk.text,
					query: options.query,
					provider: "gemini-acp",
					model,
					chunk,
				});
			},
		);
		if (results.length === 0) {
			return {
				provider: "gemini-acp",
				model,
				results,
				error: providerError(
					"GEMINI_ACP_EMPTY_RESULTS",
					"provider_search",
					"Gemini ACP returned no search results.",
				),
			};
		}
		return storeSearchResults(
			"gemini-acp",
			results,
			options.rootDir,
			options.query,
			deps.onProgress,
			model,
		);
	} catch (cause) {
		if (isAuthOrGroundingFailure(cause)) {
			invalidateSearchPreflight(commandSettings, true);
		}
		const aborted = signal?.aborted === true || isAbortError(cause);
		return {
			provider: "gemini-acp",
			model,
			results: [],
			error: providerError(
				aborted ? "GEMINI_ACP_ABORTED" : "GEMINI_ACP_FAILED",
				"provider_search",
				aborted
					? "Gemini ACP search was aborted."
					: cause instanceof Error
						? cause.message
						: "Gemini ACP search failed",
				{ cause },
			),
		};
	}
}

function isAuthOrGroundingFailure(cause: unknown): boolean {
	const code = structuredErrorCode(cause);
	return (
		code === "GEMINI_ACP_UNAUTHENTICATED" ||
		code === "GEMINI_ACP_NO_SEARCH_GROUNDING" ||
		code === "GEMINI_ACP_SEARCH_UNAVAILABLE"
	);
}

function structuredErrorCode(
	cause: unknown,
	seen = new Set<object>(),
): string | undefined {
	const record = asRecord(cause);
	if (!record || seen.has(record)) return undefined;
	seen.add(record);
	const code = record.code;
	if (typeof code === "string") return code;
	return structuredErrorCode(record.cause, seen);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

async function storeSearchResults(
	provider: SearchRunResult["provider"],
	results: SearchResultItem[],
	rootDir: string | undefined,
	query: string,
	onProgress?: SearchProgressHandler,
	model?: string,
	indexRecall = false,
): Promise<SearchRunResult> {
	await emitProgress(onProgress, {
		phase: "store_results",
		message: `Storing ${results.length} search result(s).`,
		query,
		provider,
		model,
		resultCount: results.length,
	});
	const payload = { provider, model, results };
	const stored = await storeResult(payload, { rootDir });
	if (indexRecall && results.length > 0) {
		await indexStoredSearchResultForRecall({
			...payload,
			query,
			rootDir,
			responseId: stored.responseId,
			path: stored.path,
		});
	}
	await emitProgress(onProgress, {
		phase: "complete",
		message: `Search complete with ${results.length} result(s).`,
		query,
		provider,
		model,
		resultCount: results.length,
		responseId: stored.responseId,
	});
	return {
		provider,
		model,
		results,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

async function indexStoredSearchResultForRecall(options: {
	provider: SearchRunResult["provider"];
	model?: string;
	results: SearchResultItem[];
	query: string;
	rootDir?: string;
	responseId: string;
	path: string;
}): Promise<void> {
	try {
		const bytes = (await stat(options.path)).size;
		const db = await openResponseCacheDb({ rootDir: options.rootDir });
		try {
			db.put({
				cacheKey: `recall:gemini_search:${options.responseId}`,
				responseId: options.responseId,
				tool: "gemini_search",
				model: options.model,
				sourceHash: options.provider,
				bytes,
			});
		} finally {
			db.close();
		}
		await upsertLexicalRecallEntry({
			responseId: options.responseId,
			tool: "gemini_search",
			inputs: { query: options.query },
			result: {
				provider: options.provider,
				model: options.model,
				results: options.results,
				sourceText: sourceTextForLexicalRecall({ results: options.results }),
			},
			rootDir: options.rootDir,
		});
	} catch {
		/* Local recall indexing is best-effort; stored search results still work. */
	}
}

async function emitProgress(
	onProgress: SearchProgressHandler | undefined,
	update: SearchProgressUpdate,
): Promise<void> {
	await onProgress?.(update);
}

function localSearch(
	query: string,
	docs: NonNullable<SearchOptions["localDocuments"]>,
): SearchResultItem[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return [];
	const terms = SEARCH_HAS_WHITESPACE_RE.test(normalizedQuery)
		? normalizedQuery.split(SEARCH_TERM_SPLIT_RE)
		: undefined;
	const results: SearchResultItem[] = [];
	for (let index = 0; index < docs.length; index += 1) {
		const doc = docs[index];
		const haystack =
			`${doc.title ?? ""} ${doc.text ?? ""} ${doc.snippet ?? ""}`.toLowerCase();
		if (terms) {
			if (!terms.some((term) => haystack.includes(term))) continue;
		} else if (!haystack.includes(normalizedQuery)) continue;
		const normalizedUrl = normalizeUrl(doc.url);
		results.push({
			title: doc.title ?? normalizedUrl,
			url: doc.url,
			normalizedUrl,
			snippet: doc.snippet ?? doc.text?.slice(0, 240),
			ranking: index + 1,
			source: {
				provider: "local",
				kind: "local",
				requiresCloud: false,
				requiresApiKey: false,
			},
		});
	}
	return results;
}

function geminiAcpModelLabel(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
): string {
	return (
		settings?.model?.trim() ||
		modelFromArgs(commandSettings.args) ||
		"Gemini ACP default"
	);
}

function modelFromArgs(
	args: readonly string[] | undefined,
): string | undefined {
	if (!args) return undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if ((arg === "--model" || arg === "-m") && args[index + 1]?.trim()) {
			return args[index + 1].trim();
		}
		if (arg?.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (value) return value;
		}
	}
	return undefined;
}
