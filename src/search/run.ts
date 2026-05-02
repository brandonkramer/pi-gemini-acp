import { type GeminiAcpClient, StdioGeminiAcpClient } from "../acp/client.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import {
	preflightGeminiAcpProvider,
	type StatusCommandChecker,
} from "../config/status.js";
import { storeResult } from "../storage/results.js";
import type {
	GeminiAcpConfig,
	SearchResultItem,
	StructuredError,
} from "../types.js";
import { normalizeUrl } from "../url/normalize.js";

export type CommandChecker = StatusCommandChecker;

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

export interface SearchDeps {
	geminiAcpClient?: GeminiAcpClient;
	commandExists?: CommandChecker;
}

export interface SearchRunResult {
	provider: "local" | "gemini-acp";
	results: SearchResultItem[];
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

export async function runSearch(
	options: SearchOptions,
	deps: SearchDeps = {},
	signal?: AbortSignal,
): Promise<SearchRunResult> {
	if (options.localDocuments?.length) {
		return storeSearchResults(
			"local",
			localSearch(options.query, options.localDocuments),
			options.rootDir,
		);
	}

	const loadedConfig =
		options.config ??
		configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const config = withDefaultGeminiAcpConfig(loadedConfig);
	const settings = config.providers?.["gemini-acp"];
	const preflight = await preflightGeminiAcpProvider(settings, {
		commandExists: deps.commandExists,
		requireSearchGrounding: true,
	});
	if (preflight)
		return { provider: "gemini-acp", results: [], error: preflight };

	const client =
		deps.geminiAcpClient ??
		new StdioGeminiAcpClient(buildGeminiAcpCommandSettings(settings));
	try {
		const results = await client.search(
			{ query: options.query, maxResults: options.maxResults ?? 5 },
			signal,
		);
		if (results.length === 0) {
			return {
				provider: "gemini-acp",
				results,
				error: providerError(
					"GEMINI_ACP_EMPTY_RESULTS",
					"provider_search",
					"Gemini ACP returned no search results.",
				),
			};
		}
		return storeSearchResults("gemini-acp", results, options.rootDir);
	} catch (cause) {
		return {
			provider: "gemini-acp",
			results: [],
			error: {
				...providerError(
					"GEMINI_ACP_FAILED",
					"provider_search",
					cause instanceof Error ? cause.message : "Gemini ACP search failed",
				),
				cause,
			},
		};
	}
}

async function storeSearchResults(
	provider: SearchRunResult["provider"],
	results: SearchResultItem[],
	rootDir?: string,
): Promise<SearchRunResult> {
	const stored = await storeResult({ provider, results }, { rootDir });
	return {
		provider,
		results,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

function localSearch(
	query: string,
	docs: NonNullable<SearchOptions["localDocuments"]>,
): SearchResultItem[] {
	const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
	return docs.flatMap((doc, index) => {
		const haystack =
			`${doc.title ?? ""} ${doc.text ?? ""} ${doc.snippet ?? ""}`.toLowerCase();
		if (!terms.some((term) => haystack.includes(term))) return [];
		const normalizedUrl = normalizeUrl(doc.url);
		return [
			{
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
			},
		];
	});
}

function providerError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}
