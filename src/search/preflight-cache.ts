import {
	geminiAcpClientCacheKey,
	onGeminiAcpClientCacheEntryRemoved,
} from "../acp/client-cache.ts";
/** @file Gemini ACP search preflight cache with success-only TTL semantics. */
import type { GeminiAcpCommandSettings } from "../acp/client.ts";
import {
	preflightGeminiAcpProvider,
	type GeminiAcpProviderPreflightOptions,
} from "../config/status.ts";
import type { GeminiAcpProviderSettings, StructuredError } from "../types.ts";

interface PreflightCacheEntry {
	clientCacheKey: string;
	result: StructuredError | undefined;
	expiresAt: number;
}

const DEFAULT_SEARCH_PREFLIGHT_TTL_MS = 900_000;
const SEARCH_PREFLIGHT_TTL_ENV = "PI_GEMINI_ACP_SEARCH_PREFLIGHT_TTL_MS";

const searchPreflightCache = new Map<string, PreflightCacheEntry>();

onGeminiAcpClientCacheEntryRemoved((clientCacheKey) => {
	invalidateSearchPreflightForClientCacheKey(clientCacheKey);
});

/** Resets process-local Gemini search preflight state for deterministic tests. */
export function __resetGeminiSearchPreflightCache(): void {
	searchPreflightCache.clear();
}

/** Primes the Gemini search preflight cache only after a successful preflight. */
export async function primeSuccessfulGeminiSearchPreflight(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
	options: GeminiAcpProviderPreflightOptions,
): Promise<StructuredError | undefined> {
	return await preflightSearchProvider(settings, commandSettings, options, true);
}

/** Runs provider preflight through the success-only search preflight cache. */
export async function preflightSearchProvider(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
	options: GeminiAcpProviderPreflightOptions,
	useCache: boolean,
): Promise<StructuredError | undefined> {
	if (!useCache) return await preflightGeminiAcpProvider(settings, options);
	const key = searchPreflightCacheKey(commandSettings, true);
	const cached = cachedSearchPreflight(key);
	if (cached) return cached.result;
	const result = await preflightGeminiAcpProvider(settings, options);
	if (!result) setSuccessfulSearchPreflight(key, commandSettings, result);
	return result;
}

/** Invalidates cached successful search preflight for one command setting. */
export function invalidateSearchPreflight(
	settings: GeminiAcpCommandSettings,
	requireSearchGrounding: boolean,
): void {
	searchPreflightCache.delete(searchPreflightCacheKey(settings, requireSearchGrounding));
}

function cachedSearchPreflight(key: string): PreflightCacheEntry | undefined {
	const cached = searchPreflightCache.get(key);
	if (!cached) return undefined;
	if (cached.expiresAt > Date.now()) return cached;
	searchPreflightCache.delete(key);
	return undefined;
}

function setSuccessfulSearchPreflight(
	key: string,
	settings: GeminiAcpCommandSettings,
	result: undefined,
): void {
	searchPreflightCache.set(key, {
		clientCacheKey: geminiAcpClientCacheKey(settings),
		result,
		expiresAt: Date.now() + searchPreflightTtlMs(),
	});
}

function searchPreflightTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env[SEARCH_PREFLIGHT_TTL_ENV]);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SEARCH_PREFLIGHT_TTL_MS;
}

function searchPreflightCacheKey(
	settings: GeminiAcpCommandSettings,
	requireSearchGrounding: boolean,
): string {
	return JSON.stringify({
		clientCacheKey: geminiAcpClientCacheKey(settings),
		requireSearchGrounding,
	});
}

function invalidateSearchPreflightForClientCacheKey(clientCacheKey: string): void {
	for (const [key, entry] of searchPreflightCache) {
		if (entry.clientCacheKey === clientCacheKey) {
			searchPreflightCache.delete(key);
		}
	}
}
