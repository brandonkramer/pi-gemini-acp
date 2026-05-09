import type { SearchResultItem } from "../types.js";
import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptRequest,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpSearchRequest,
} from "./client.js";
import {
	normalizeGeminiAcpSearchResults,
	parseSearchPayload,
	searchSessionCwd,
} from "./client.js";
import { createGeminiAcpSearchEarlyStop } from "./search-early-stop.js";
import { searchPrompt } from "./search-prompt.js";
import {
	AcpProcessSession,
	type GeminiAcpProcessSession,
	type GeminiAcpProcessSessionFactory,
} from "./session.js";

export const DEFAULT_IDLE_TTL_MS = 900_000;
const IDLE_TTL_ENV = "PI_GEMINI_ACP_IDLE_TTL_MS";

type CacheRemovalListener = (key: string) => void;

const cacheRemovalListeners = new Set<CacheRemovalListener>();

export type GeminiAcpClientCachePurpose = "search" | "prompt";

interface ActiveProcess {
	session: GeminiAcpProcessSession;
	searchSessions: Map<string, SearchSessionEntry[]>;
}

interface SearchSessionEntry {
	sessionId: Promise<string>;
	busy: boolean;
}

interface CachedClientEntry {
	client: CachedGeminiAcpClient;
}

export interface GeminiAcpClientWarmOptions {
	signal?: AbortSignal;
}

export interface GeminiAcpClientCacheOptions {
	idleTtlMs?: number;
	sessionFactory?: GeminiAcpProcessSessionFactory;
}

/** Short-lived cache for warm Gemini ACP process reuse. */
export class GeminiAcpClientCache {
	private readonly entries = new Map<string, CachedClientEntry>();
	private readonly idleTtlMs: number;
	private readonly sessionFactory: GeminiAcpProcessSessionFactory;

	constructor(options: GeminiAcpClientCacheOptions = {}) {
		this.idleTtlMs = options.idleTtlMs ?? defaultGeminiAcpIdleTtlMs();
		this.sessionFactory = options.sessionFactory ?? AcpProcessSession.start;
	}

	/** Returns a cached client keyed by effective command args/capabilities/purpose. */
	get(
		settings: GeminiAcpCommandSettings,
		purpose: GeminiAcpClientCachePurpose = "search",
	): GeminiAcpClient {
		const key = cacheKey(settings, purpose);
		const entry = this.entries.get(key);
		if (entry) return entry.client;
		let client!: CachedGeminiAcpClient;
		client = new CachedGeminiAcpClient(
			settings,
			this.sessionFactory,
			this.idleTtlMs,
			() => {
				if (this.entries.get(key)?.client === client) {
					this.entries.delete(key);
					notifyGeminiAcpClientCacheEntryRemoved(key);
				}
			},
		);
		this.entries.set(key, { client });
		return client;
	}

	/** Warms the cached search subprocess and default neutral search session. */
	async warmSearch(
		settings: GeminiAcpCommandSettings,
		options: GeminiAcpClientWarmOptions = {},
	): Promise<void> {
		await this.cachedClient(settings, "search").warmSearchSession(
			options.signal,
		);
	}

	/** Closes every warm ACP subprocess currently retained by this cache. */
	async close(): Promise<void> {
		const clients = [...this.entries.values()].map((entry) => entry.client);
		this.entries.clear();
		await Promise.all(clients.map((client) => client.close()));
	}

	private cachedClient(
		settings: GeminiAcpCommandSettings,
		purpose: GeminiAcpClientCachePurpose,
	): CachedGeminiAcpClient {
		return this.get(settings, purpose) as CachedGeminiAcpClient;
	}
}

const defaultCache = new GeminiAcpClientCache();

/** Returns the effective production idle TTL from environment or the 15 minute default. */
export function defaultGeminiAcpIdleTtlMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[IDLE_TTL_ENV];
	if (!raw) return DEFAULT_IDLE_TTL_MS;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TTL_MS;
}

/** Registers a process-local listener for cached ACP client entry removal. */
export function onGeminiAcpClientCacheEntryRemoved(
	listener: CacheRemovalListener,
): () => void {
	cacheRemovalListeners.add(listener);
	return () => cacheRemovalListeners.delete(listener);
}

/** Returns the stable key used for warm Gemini ACP client cache entries. */
export function geminiAcpClientCacheKey(
	settings: GeminiAcpCommandSettings,
	purpose: GeminiAcpClientCachePurpose,
): string {
	return cacheKey(settings, purpose);
}

/** Returns the process-cached Gemini ACP client for production workflows. */
export function getCachedGeminiAcpClient(
	settings: GeminiAcpCommandSettings,
	purpose: GeminiAcpClientCachePurpose = "search",
): GeminiAcpClient {
	return defaultCache.get(settings, purpose);
}

/** Warms the production Gemini ACP search cache without sending user-visible work. */
export async function warmCachedGeminiAcpSearchClient(
	settings: GeminiAcpCommandSettings,
	options: GeminiAcpClientWarmOptions = {},
): Promise<void> {
	await defaultCache.warmSearch(settings, options);
}

/** Closes production cached clients; primarily useful for tests and shutdown hooks. */
export async function closeGeminiAcpClientCache(): Promise<void> {
	await defaultCache.close();
}

class CachedGeminiAcpClient implements GeminiAcpClient {
	private active?: Promise<ActiveProcess>;
	private queue: Promise<unknown> = Promise.resolve();
	private idleTimer?: ReturnType<typeof setTimeout>;
	private activeOperations = 0;
	private removedFromCache = false;

	constructor(
		private readonly settings: GeminiAcpCommandSettings,
		private readonly sessionFactory: GeminiAcpProcessSessionFactory,
		private readonly idleTtlMs: number,
		private readonly removeFromCache: () => void,
	) {}

	async search(
		request: GeminiAcpSearchRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<SearchResultItem[]> {
		const earlyStop = createGeminiAcpSearchEarlyStop(onUpdate);

		// Emit warm process progress with model info
		const model = request.model ?? "Gemini ACP";
		request.onProgress?.("warm", `Warm ACP process ready (${model}).`);

		const text = await this.promptOnSearchSession(
			searchSessionCwd(request.cwd),
			searchPrompt(request),
			signal,
			earlyStop.onUpdate,
			earlyStop.signal,
			request.onProgress,
			{
				query: request.query,
				maxResults: request.maxResults,
				model: request.model,
			},
		);
		return normalizeGeminiAcpSearchResults(
			earlyStop.parsedPayload() ?? parseSearchPayload(text),
		);
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		return this.enqueue(async () =>
			// Prompt workflows may depend on the caller/project cwd; only search uses
			// the neutral cwd from searchSessionCwd() to avoid project discovery churn.
			this.promptOnFreshSession(
				request.cwd ?? process.cwd(),
				request.prompt,
				signal,
				onUpdate,
			),
		);
	}

	async close(): Promise<void> {
		this.clearIdleTimer();
		this.removeFromCacheOnce();
		await this.closeActive();
	}

	async warmSearchSession(signal?: AbortSignal): Promise<void> {
		await this.enqueue(() =>
			this.withWarmProcess(signal, async (active) => {
				await this.ensureIdleSearchSession(active, searchSessionCwd(undefined));
			}),
		);
	}

	private async promptOnSearchSession(
		cwd: string,
		text: string,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
		promptSignal?: AbortSignal,
		onProgress?: (
			phase: "warm" | "session" | "search",
			message: string,
		) => void,
		searchContext?: { query: string; maxResults: number; model?: string },
	): Promise<string> {
		return this.withWarmProcess(signal, async (active) => {
			const model = searchContext?.model ?? "Gemini ACP";
			const query = searchContext?.query ?? "";
			const maxResults = searchContext?.maxResults ?? 4;
			onProgress?.(
				"session",
				`Creating search session for "${query}" (${maxResults} results).`,
			);
			const entry = this.claimSearchSession(active, cwd);
			try {
				const sessionId = await entry.sessionId;
				onProgress?.(
					"search",
					`Executing web search: "${query}" with ${maxResults} max results via ${model}.\n\n- Web search grounding\n- LLM token generation\n- Streaming first chunk back`,
				);
				return await active.session.prompt(sessionId, text, onUpdate, {
					signal: promptSignal,
					returnTextOnAbort: true,
				});
			} finally {
				entry.busy = false;
			}
		});
	}

	private async ensureIdleSearchSession(
		active: ActiveProcess,
		cwd: string,
	): Promise<void> {
		const entries = active.searchSessions.get(cwd) ?? [];
		if (entries.length > 0) return;
		const entry = this.createSearchSession(active, cwd, false);
		await entry.sessionId;
	}

	private claimSearchSession(
		active: ActiveProcess,
		cwd: string,
	): SearchSessionEntry {
		const entries = active.searchSessions.get(cwd) ?? [];
		const idle = entries.find((entry) => !entry.busy);
		if (idle) {
			idle.busy = true;
			return idle;
		}
		return this.createSearchSession(active, cwd, true);
	}

	private createSearchSession(
		active: ActiveProcess,
		cwd: string,
		busy: boolean,
	): SearchSessionEntry {
		const entries = active.searchSessions.get(cwd) ?? [];
		const entry: SearchSessionEntry = {
			busy,
			sessionId: active.session.newSession(cwd).catch((error) => {
				const current = active.searchSessions.get(cwd);
				if (current?.includes(entry)) {
					active.searchSessions.set(
						cwd,
						current.filter((candidate) => candidate !== entry),
					);
				}
				throw error;
			}),
		};
		entries.push(entry);
		active.searchSessions.set(cwd, entries);
		return entry;
	}

	private async promptOnFreshSession(
		cwd: string,
		text: string,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		return this.withWarmProcess(signal, async (active) => {
			const sessionId = await active.session.newSession(cwd);
			return active.session.prompt(sessionId, text, onUpdate, { signal });
		});
	}

	private async withWarmProcess<T>(
		signal: AbortSignal | undefined,
		operation: (active: ActiveProcess) => Promise<T>,
	): Promise<T> {
		if (signal?.aborted) {
			await this.close();
			throw abortError();
		}
		this.clearIdleTimer();
		this.activeOperations += 1;
		const abort = () => {
			void this.close();
		};
		signal?.addEventListener("abort", abort, { once: true });
		let keepWarm = false;
		try {
			const active = await this.ensureActive(signal);
			const response = await operation(active);
			keepWarm = true;
			return response;
		} catch (error) {
			await this.close();
			if (signal?.aborted) throw abortError();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.activeOperations = Math.max(0, this.activeOperations - 1);
			if (keepWarm && !signal?.aborted && this.activeOperations === 0) {
				this.scheduleIdleCleanup();
			}
		}
	}

	private ensureActive(signal?: AbortSignal): Promise<ActiveProcess> {
		this.active ??= this.createActive(signal).catch((error) => {
			this.active = undefined;
			throw error;
		});
		return this.active;
	}

	private async createActive(signal?: AbortSignal): Promise<ActiveProcess> {
		const session = await this.sessionFactory(this.settings, signal);
		try {
			await session.initialize();
			return { session, searchSessions: new Map() };
		} catch (error) {
			await session.close();
			throw error;
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.queue.then(operation, operation);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private scheduleIdleCleanup(): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			void this.close();
		}, this.idleTtlMs);
		this.idleTimer.unref?.();
	}

	private removeFromCacheOnce(): void {
		if (this.removedFromCache) return;
		this.removedFromCache = true;
		this.removeFromCache();
	}

	private clearIdleTimer(): void {
		if (!this.idleTimer) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async closeActive(): Promise<void> {
		const active = this.active;
		this.active = undefined;
		if (!active) return;
		try {
			await (await active).session.close();
		} catch {
			/* Failed starts are already invalidated; callers get the original error. */
		}
	}
}

function notifyGeminiAcpClientCacheEntryRemoved(key: string): void {
	for (const listener of cacheRemovalListeners) listener(key);
}

function cacheKey(
	settings: GeminiAcpCommandSettings,
	purpose: GeminiAcpClientCachePurpose,
): string {
	return JSON.stringify({
		purpose,
		command: settings.command,
		args: settings.args ?? [],
		permissionPolicy: normalizedPermissionPolicy(settings.permissionPolicy),
	});
}

function normalizedPermissionPolicy(
	policy: GeminiAcpCommandSettings["permissionPolicy"],
): Record<string, boolean> {
	return {
		filesystemRead: policy?.filesystemRead === true,
		filesystemWrite: policy?.filesystemWrite === true,
		terminal: policy?.terminal === true,
	};
}

function abortError(): Error {
	return new DOMException("Gemini ACP request aborted", "AbortError");
}
