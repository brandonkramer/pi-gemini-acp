import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptChunk,
} from "../acp/client.js";
import {
	geminiAcpClientCacheKey,
	getCachedGeminiAcpClient,
	onGeminiAcpClientCacheEntryRemoved,
} from "../acp/client-cache.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import {
	type GeminiAcpAuthProbe,
	preflightGeminiAcpProvider,
	type StatusCommandChecker,
} from "../config/status.js";
import { isAbortError, providerError } from "../prompt/provider-result.js";
import { storeResult } from "../storage/results.js";
import type {
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
	SearchResultItem,
	StructuredError,
} from "../types.js";
import { normalizeUrl } from "../url/normalize.js";

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

interface PreflightCacheEntry {
	clientCacheKey: string;
	result: StructuredError | undefined;
}

const SEARCH_TERM_SPLIT_RE = /\s+/u;
const SEARCH_HAS_WHITESPACE_RE = /\s/u;

const searchPreflightCache = new Map<string, PreflightCacheEntry>();

onGeminiAcpClientCacheEntryRemoved((clientCacheKey) => {
	invalidateSearchPreflightForClientCacheKey(clientCacheKey);
});

/** Resets process-local Gemini search preflight state for deterministic tests. */
export function __resetGeminiSearchPreflightCache(): void {
	searchPreflightCache.clear();
}

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
			{ query: options.query, maxResults },
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

/** Primes the Gemini search preflight cache only after a successful preflight. */
export async function primeSuccessfulGeminiSearchPreflight(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
	options: Parameters<typeof preflightGeminiAcpProvider>[1],
): Promise<StructuredError | undefined> {
	const key = searchPreflightCacheKey(commandSettings, true);
	const cached = searchPreflightCache.get(key);
	if (cached) return cached.result;
	const result = await preflightGeminiAcpProvider(settings, options);
	if (!result) {
		searchPreflightCache.set(key, {
			clientCacheKey: geminiAcpClientCacheKey(commandSettings, "search"),
			result,
		});
	}
	return result;
}

async function preflightSearchProvider(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
	options: Parameters<typeof preflightGeminiAcpProvider>[1],
	useCache: boolean,
): Promise<StructuredError | undefined> {
	if (!useCache) return await preflightGeminiAcpProvider(settings, options);
	const key = searchPreflightCacheKey(commandSettings, true);
	const cached = searchPreflightCache.get(key);
	if (cached) return cached.result;
	const result = await preflightGeminiAcpProvider(settings, options);
	searchPreflightCache.set(key, {
		clientCacheKey: geminiAcpClientCacheKey(commandSettings, "search"),
		result,
	});
	return result;
}

function searchPreflightCacheKey(
	settings: GeminiAcpCommandSettings,
	requireSearchGrounding: boolean,
): string {
	return JSON.stringify({
		clientCacheKey: geminiAcpClientCacheKey(settings, "search"),
		requireSearchGrounding,
	});
}

function invalidateSearchPreflight(
	settings: GeminiAcpCommandSettings,
	requireSearchGrounding: boolean,
): void {
	searchPreflightCache.delete(
		searchPreflightCacheKey(settings, requireSearchGrounding),
	);
}

function invalidateSearchPreflightForClientCacheKey(
	clientCacheKey: string,
): void {
	for (const [key, entry] of searchPreflightCache) {
		if (entry.clientCacheKey === clientCacheKey)
			searchPreflightCache.delete(key);
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
): Promise<SearchRunResult> {
	await emitProgress(onProgress, {
		phase: "store_results",
		message: `Storing ${results.length} search result(s).`,
		query,
		provider,
		model,
		resultCount: results.length,
	});
	const stored = await storeResult({ provider, model, results }, { rootDir });
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
