/** @file Gemini API key configuration loading. */

// Name of the environment variable that holds the Gemini API key (not the key itself).
const API_KEY_ENV = "GEMINI_API_KEY";

export interface GeminiApiKeyConfig {
	apiKey: string;
}

/** Loads API key config from merged config (persisted + env) if present. */
export function loadGeminiApiKeyConfig(config?: {
	providers?: { "gemini-acp"?: { apiKey?: string } };
}): GeminiApiKeyConfig | undefined {
	const apiKey =
		config?.providers?.["gemini-acp"]?.apiKey?.trim() ?? process.env[API_KEY_ENV]?.trim();
	if (!apiKey) return undefined;
	return { apiKey };
}

/** Returns true when a Gemini API key is configured. */
export function geminiApiKeyConfigured(config?: {
	providers?: { "gemini-acp"?: { apiKey?: string } };
}): boolean {
	return Boolean(
		config?.providers?.["gemini-acp"]?.apiKey?.trim() ?? process.env[API_KEY_ENV]?.trim(),
	);
}
