import { access } from "node:fs/promises";
import path from "node:path";
import { type GeminiAcpClient, StdioGeminiAcpClient } from "../acp/client.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import { configFromEnv, loadConfig } from "../config/settings.js";
import { storeResult } from "../storage/results.js";
import type {
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
	SearchResultItem,
	StructuredError,
} from "../types.js";
import { normalizeUrl } from "../url/normalize.js";

export type CommandChecker = (command: string) => Promise<boolean>;

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

	const config =
		options.config ??
		configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const settings = config.providers?.["gemini-acp"];
	const preflight = await preflightGemini(
		settings,
		deps.commandExists ?? commandExists,
	);
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

async function preflightGemini(
	config: GeminiAcpProviderSettings | undefined,
	exists: CommandChecker,
): Promise<StructuredError | undefined> {
	if (config?.enabled !== true || !config.command)
		return providerError(
			"GEMINI_ACP_MISSING_CONFIG",
			"provider_preflight",
			"Gemini ACP search is not configured.",
		);
	if (!(await exists(config.command)))
		return providerError(
			"GEMINI_ACP_COMMAND_NOT_FOUND",
			"provider_preflight",
			`Gemini ACP command '${config.command}' was not found.`,
		);
	if (config.authenticated !== true)
		return providerError(
			"GEMINI_ACP_UNAUTHENTICATED",
			"provider_preflight",
			"Gemini ACP is configured but authentication has not been confirmed.",
		);
	if (
		config.requiresSearchGrounding !== false &&
		config.searchGroundingAvailable !== true
	)
		return providerError(
			"GEMINI_ACP_SEARCH_UNAVAILABLE",
			"provider_preflight",
			"Gemini ACP is not confirmed to expose web/search grounding.",
		);
	if (config.model && config.modelSelectionAvailable !== true)
		return providerError(
			"GEMINI_ACP_MODEL_SELECTION_UNCONFIRMED",
			"provider_preflight",
			"A Gemini model is configured, but this ACP runtime has not confirmed --model support. Run /gemini-set-model after configuring the ACP command.",
		);
	return undefined;
}

function providerError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}

async function commandExists(command: string): Promise<boolean> {
	if (command.includes(path.sep)) {
		try {
			await access(command);
			return true;
		} catch {
			return false;
		}
	}
	for (const dir of (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)) {
		try {
			await access(path.join(dir, command));
			return true;
		} catch {
			/* continue */
		}
	}
	return false;
}
