/**
 * @file Gemini API key HTTP client implementing GeminiAcpClient interface. Provides a fallback when
 *   local ACP is unavailable by calling the Gemini REST API directly. Search uses the google_search
 *   tool for grounded results.
 */
import type {
	GeminiAcpClient,
	GeminiAcpPromptRequest,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpSearchRequest,
} from "../acp/client.js";
import { coerceString } from "../coerce.js";
import type { SearchProviderMetadata, SearchResultItem } from "../types.js";
import { loadGeminiApiKeyConfig } from "./config.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Injectable dependencies for the API key client. */
export interface GeminiApiKeyClientDeps {
	fetch?: typeof globalThis.fetch;
	config?: {
		providers?: { "gemini-acp"?: { apiKey?: string } };
	};
	/** Model to use for this API key call (from ACP settings, not config). */
	model?: string;
}

/** Client that calls Gemini REST API with an API key, satisfying GeminiAcpClient. */
export class GeminiApiKeyClient implements GeminiAcpClient {
	private readonly apiKey: string;
	private readonly defaultModel: string;
	private readonly fetch: typeof globalThis.fetch;

	constructor(deps: GeminiApiKeyClientDeps = {}) {
		const config = loadGeminiApiKeyConfig(deps.config);
		if (!config) {
			throw new Error(
				"GeminiApiKeyClient requires GEMINI_API_KEY environment variable or settings.json apiKey.",
			);
		}
		this.apiKey = config.apiKey;
		this.defaultModel = deps.model ?? "gemini-1.5-flash";
		this.fetch = deps.fetch ?? globalThis.fetch;
	}

	async search(
		request: GeminiAcpSearchRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<SearchResultItem[]> {
		const promptText = buildSearchPrompt(request);
		const body = {
			contents: [{ role: "user", parts: [{ text: promptText }] }],
			tools: [{ google_search: {} }],
		};

		const url = `${API_BASE}/${request.model ?? this.defaultModel}:generateContent?key=${this.apiKey}`;
		const response = await this.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const message = `Gemini API search failed (${response.status}): ${errorText}`;
			if (isQuotaErrorStatus(response.status, errorText)) {
				throw new GeminiApiQuotaError(message);
			}
			throw new Error(message);
		}

		const data = (await response.json()) as GenerateContentResponse;
		const text = extractResponseText(data);

		// Emit the full text as a single chunk to keep streaming contract
		if (onUpdate && text) {
			await onUpdate({ type: "chunk", text, accumulatedText: text });
		}

		return extractSearchResults(data, text, request.maxResults);
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		const parts = request.parts ?? [{ type: "text", text: request.prompt }];
		const textParts = parts
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => ({ text: p.text }));

		const body = {
			contents: [{ role: "user", parts: textParts }],
		};

		const url = `${API_BASE}/${this.defaultModel}:generateContent?key=${this.apiKey}`;
		const response = await this.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const message = `Gemini API prompt failed (${response.status}): ${errorText}`;
			if (isQuotaErrorStatus(response.status, errorText)) {
				throw new GeminiApiQuotaError(message);
			}
			throw new Error(message);
		}

		const data = (await response.json()) as GenerateContentResponse;
		const text = extractResponseText(data);

		if (onUpdate && text) {
			await onUpdate({ type: "chunk", text, accumulatedText: text });
		}

		return text;
	}
}

function isQuotaErrorStatus(status: number, text: string): boolean {
	return (
		status === 429 ||
		/status\s*429|quota|exhausted|capacity|rate.limit|ResourceExhausted/iu.test(text)
	);
}

class GeminiApiQuotaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GeminiApiQuotaError";
	}
}

function buildSearchPrompt(request: GeminiAcpSearchRequest): string {
	return [
		"Search the web and return results as a JSON array.",
		"Each item must have: title, url, snippet.",
		`Return at most ${request.maxResults} results.`,
		`Query: ${request.query}`,
		"Return only the JSON array, no markdown fences or commentary.",
	].join("\n");
}

function extractResponseText(data: GenerateContentResponse): string {
	const parts = data.candidates?.[0]?.content?.parts ?? [];
	return parts.map((p) => p.text ?? "").join("");
}

function extractSearchResults(
	data: GenerateContentResponse,
	fallbackText: string,
	maxResults: number,
): SearchResultItem[] {
	// Try to extract structured results from grounding metadata
	const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
	const fromMetadata: SearchResultItem[] = [];
	for (let i = 0; i < chunks.length && fromMetadata.length < maxResults; i++) {
		const web = chunks[i]?.web;
		if (web?.title && web?.uri) {
			fromMetadata.push({
				title: web.title,
				url: web.uri,
				normalizedUrl: web.uri,
				snippet: web.content ?? "",
				ranking: fromMetadata.length + 1,
				source: apiKeyMetadata(),
			});
		}
	}
	if (fromMetadata.length > 0) return fromMetadata;

	// Fallback: try to parse JSON array from the response text
	const parsed = tryParseJsonArray(fallbackText);
	if (parsed) {
		return parsed.slice(0, maxResults).map((item, index) => normalizeSearchItem(item, index + 1));
	}

	return [];
}

function tryParseJsonArray(text: string): unknown[] | undefined {
	// Find first [ and last ]
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1));
		if (Array.isArray(parsed)) return parsed;
	} catch {
		// ignore parse errors
	}
	return undefined;
}

function normalizeSearchItem(item: unknown, ranking: number): SearchResultItem {
	const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
	const url = coerceString(record.url) ?? coerceString(record.link) ?? "";
	return {
		title: coerceString(record.title) ?? url,
		url,
		normalizedUrl: url,
		snippet: coerceString(record.snippet) ?? coerceString(record.summary) ?? "",
		ranking,
		source: apiKeyMetadata(),
	};
}

function apiKeyMetadata(): SearchProviderMetadata {
	return {
		provider: "gemini-api",
		kind: "gemini-acp",
		requiresCloud: true,
		requiresApiKey: true,
	};
}

// Gemini REST API response shapes
interface GenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
		groundingMetadata?: {
			groundingChunks?: Array<{
				web?: {
					title?: string;
					uri?: string;
					content?: string;
				};
			}>;
		};
	}>;
}
