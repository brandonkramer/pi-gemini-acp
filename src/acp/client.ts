/** @file Narrow Gemini ACP client contracts, one-shot process helpers, and response normalization. */
import { homedir } from "node:os";

import type {
	GeminiAcpPermissionPolicy,
	SearchProviderMetadata,
	SearchResultItem,
} from "../types.ts";
import { coerceFiniteNumber, coerceString } from "../utils/coerce.ts";
import { normalizeUrl } from "../utils/normalize.ts";
import { createGeminiAcpSearchEarlyStop } from "./search-early-stop.ts";
import { searchPrompt } from "./search-prompt.ts";
import { AcpProcessSession, permissionOptionId } from "./session.ts";

export { permissionOptionId };

/** Local command settings used to launch a Gemini ACP subprocess. */
export interface GeminiAcpCommandSettings {
	command: string;
	args?: string[];
	permissionPolicy?: GeminiAcpPermissionPolicy;
	allowedReadPaths?: readonly string[];
}

/** Search prompt request normalized before sending through ACP. */
export interface GeminiAcpSearchRequest {
	query: string;
	maxResults: number;
	cwd?: string;
	onProgress?: (phase: "warm" | "session" | "search", message: string) => void;
	model?: string;
}

/** ACP prompt content block that lets Gemini request one allowlisted local file. */
export interface GeminiAcpResourceLinkPart {
	type: "resource_link";
	uri: string;
	name: string;
	title?: string;
	mimeType?: string;
	size?: number;
}

/** ACP prompt content block accepted by the narrow Pi Gemini client. */
export type GeminiAcpPromptPart = { type: "text"; text: string } | GeminiAcpResourceLinkPart;

/** Plain text or multipart prompt request sent through a Gemini ACP session. */
export interface GeminiAcpPromptRequest {
	prompt?: string;
	cwd?: string;
	parts?: GeminiAcpPromptPart[];
}

/** Streaming assistant text emitted by a Gemini ACP session update. */
export interface GeminiAcpPromptChunk {
	type: "chunk";
	text: string;
	accumulatedText: string;
}

/** Callback for prompt chunk updates exposed by fake and stdio ACP clients. */
export type GeminiAcpPromptUpdateHandler = (update: GeminiAcpPromptChunk) => void | Promise<void>;

/** Narrow Gemini ACP capability surface used by Pi tools. */
export interface GeminiAcpClient {
	search(
		request: GeminiAcpSearchRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<SearchResultItem[]>;
	prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string>;
}

/** JSON-RPC-over-stdio Gemini ACP client with one subprocess per call. */
export class StdioGeminiAcpClient implements GeminiAcpClient {
	constructor(private readonly settings: GeminiAcpCommandSettings) {}

	async search(
		request: GeminiAcpSearchRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<SearchResultItem[]> {
		const session = await AcpProcessSession.start(this.settings, signal);
		try {
			await session.initialize();
			const sessionId = await session.newSession(searchSessionCwd(request.cwd));
			const earlyStop = createGeminiAcpSearchEarlyStop(onUpdate);
			const text = await session.prompt(sessionId, searchPrompt(request), earlyStop.onUpdate, {
				signal: earlyStop.signal,
				returnTextOnAbort: true,
			});
			return normalizeGeminiAcpSearchResults(
				earlyStop.parsedPayload() ?? parseSearchPayload(text),
				geminiMetadata(),
			);
		} finally {
			await session.close();
		}
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		const session = await AcpProcessSession.start(this.settings, signal);
		try {
			await session.initialize();
			const sessionId = await session.newSession(sessionCwd(request.cwd));
			return await session.prompt(
				sessionId,
				request.parts ?? [{ type: "text", text: request.prompt ?? "" }],
				onUpdate,
				{ signal },
			);
		} finally {
			await session.close();
		}
	}
}

/** Normalizes defensive Gemini ACP search payloads into stable Pi search items. */
export function normalizeGeminiAcpSearchResults(
	raw: unknown,
	metadata: SearchProviderMetadata = geminiMetadata(),
): SearchResultItem[] {
	const candidates = Array.isArray(raw) ? raw : recordsFromObject(raw);
	const normalizedUrls = new Map<string, string>();
	return candidates.flatMap((entry, index) => {
		const record = asRecord(entry);
		const url = record
			? (coerceString(record.url) ?? coerceString(record.link) ?? coerceString(record.uri))
			: undefined;
		if (!record || !url) return [];
		try {
			const normalizedUrl = normalizedSearchUrl(url, normalizedUrls);
			return [
				{
					title: coerceString(record.title) ?? normalizedUrl,
					url,
					normalizedUrl,
					snippet:
						coerceString(record.snippet) ??
						coerceString(record.summary) ??
						coerceString(record.description),
					ranking: coerceFiniteNumber(record.ranking) ?? index + 1,
					source: { ...metadata, raw: record },
				},
			];
		} catch {
			return [];
		}
	});
}

function normalizedSearchUrl(url: string, cache: Map<string, string>): string {
	const cached = cache.get(url);
	if (cached) return cached;
	const normalized = normalizeUrl(url);
	cache.set(url, normalized);
	return normalized;
}

/** Extracts JSON search payloads from raw assistant text. */
export function parseSearchPayload(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return [];
	try {
		return JSON.parse(trimmed);
	} catch {
		/* extract JSON below */
	}
	const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed)?.[1]?.trim();
	if (fenced) {
		try {
			return JSON.parse(fenced);
		} catch {
			/* continue */
		}
	}
	const start = firstJsonStart(trimmed);
	const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			/* fall through */
		}
	}
	return [];
}

/** Resolves the neutral cwd used by provider-backed search sessions. */
export function searchSessionCwd(cwd?: string): string {
	// Use a neutral existing directory unless a workflow explicitly needs a project cwd;
	// this avoids triggering Gemini CLI project-trust/agent discovery for text-only ACP tools.
	return cwd ?? (homedir() || process.cwd());
}

function sessionCwd(cwd: string | undefined): string {
	return searchSessionCwd(cwd);
}

function firstJsonStart(value: string): number {
	const objectStart = value.indexOf("{");
	const arrayStart = value.indexOf("[");
	if (objectStart < 0) return arrayStart;
	if (arrayStart < 0) return objectStart;
	return Math.min(objectStart, arrayStart);
}

function recordsFromObject(raw: unknown): unknown[] {
	const record = asRecord(raw);
	if (!record) return [];
	for (const key of ["results", "items", "sources", "citations"]) {
		const value = record[key];
		if (Array.isArray(value)) return value;
	}
	return [];
}

function geminiMetadata(): SearchProviderMetadata {
	return {
		provider: "gemini-acp",
		kind: "gemini-acp",
		requiresCloud: false,
		requiresApiKey: false,
		requiresLocalAuth: true,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
