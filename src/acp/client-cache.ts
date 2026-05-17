/** @file Warm Gemini ACP client cache for prompt and search workflows. */
import type { SearchResultItem } from "../types.ts";
import { clientCacheKey } from "./client-cache-key.ts";
import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptPart,
	GeminiAcpPromptRequest,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpSearchRequest,
} from "./client.ts";
import {
	normalizeGeminiAcpSearchResults,
	parseSearchPayload,
	requestToParts,
	searchSessionCwd,
} from "./client.ts";
import { geminiBackendProgressText, withGeminiBackendProgress } from "./prompt-progress.ts";
import { createGeminiAcpSearchEarlyStop } from "./search-early-stop.ts";
import { geminiAcpSearchParallelEnabled } from "./search-parallel.ts";
import { searchPrompt } from "./search-prompt.ts";
import {
	AcpProcessSession,
	type GeminiAcpProcessSession,
	type GeminiAcpProcessSessionFactory,
} from "./session.ts";

export const DEFAULT_IDLE_TTL_MS = 900_000;
const IDLE_TTL_ENV = "PI_GEMINI_ACP_IDLE_TTL_MS";

type CacheRemovalListener = (key: string) => void;

const cacheRemovalListeners = new Set<CacheRemovalListener>();

interface ActiveProcess {
	session: GeminiAcpProcessSession;
	searchSessions: Map<string, SearchSessionEntry[]>;
	promptSessions: Map<string, Promise<string>>;
}

interface SearchSessionEntry {
	sessionId: Promise<string>;
	busy: boolean;
}

interface SearchSessionClaim {
	entry: SearchSessionEntry;
	reused: boolean;
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
		// oxlint-disable-next-line typescript/unbound-method -- AcpProcessSession.start is static and does not reference `this`
		this.sessionFactory = options.sessionFactory ?? AcpProcessSession.start;
	}

	/** Returns a cached client keyed by effective command args/capabilities. */
	get(settings: GeminiAcpCommandSettings): GeminiAcpClient {
		const key = clientCacheKey(settings);
		const entry = this.entries.get(key);
		if (entry) return entry.client;
		let client!: CachedGeminiAcpClient;
		client = new CachedGeminiAcpClient(settings, this.sessionFactory, this.idleTtlMs, () => {
			if (this.entries.get(key)?.client === client) {
				this.entries.delete(key);
				notifyGeminiAcpClientCacheEntryRemoved(key);
			}
		});
		this.entries.set(key, { client });
		return client;
	}

	/** Warms the shared ACP subprocess and default neutral search session. */
	async warmSearch(
		settings: GeminiAcpCommandSettings,
		options: GeminiAcpClientWarmOptions = {},
	): Promise<void> {
		await (this.get(settings) as CachedGeminiAcpClient).warmSearchSession(options.signal);
	}

	/** Closes every warm ACP subprocess currently retained by this cache. */
	async close(): Promise<void> {
		const clients = [...this.entries.values()].map((entry) => entry.client);
		this.entries.clear();
		await Promise.all(clients.map((client) => client.close()));
	}
}

const defaultCache = new GeminiAcpClientCache();

/** Returns the effective production idle TTL from environment or the 15 minute default. */
export function defaultGeminiAcpIdleTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[IDLE_TTL_ENV];
	if (!raw) return DEFAULT_IDLE_TTL_MS;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TTL_MS;
}

/** Registers a process-local listener for cached ACP client entry removal. */
export function onGeminiAcpClientCacheEntryRemoved(listener: CacheRemovalListener): () => void {
	cacheRemovalListeners.add(listener);
	return () => {
		cacheRemovalListeners.delete(listener);
	};
}

/** Returns the stable key used for warm Gemini ACP client cache entries. */
export function geminiAcpClientCacheKey(settings: GeminiAcpCommandSettings): string {
	return clientCacheKey(settings);
}

/** Returns the process-cached Gemini ACP client for production workflows. */
export function getCachedGeminiAcpClient(settings: GeminiAcpCommandSettings): GeminiAcpClient {
	return defaultCache.get(settings);
}

/** Warms the shared ACP subprocess with a neutral search session. */
export async function warmCachedGeminiAcpSearchClient(
	settings: GeminiAcpCommandSettings,
	options: GeminiAcpClientWarmOptions = {},
): Promise<void> {
	await defaultCache.warmSearch(settings, options);
}

/** Warms the shared ACP subprocess with a prompt session for the given cwd. */
export async function warmCachedGeminiAcpPromptClient(
	settings: GeminiAcpCommandSettings,
	cwd: string,
	options: GeminiAcpClientWarmOptions = {},
): Promise<void> {
	await (defaultCache.get(settings) as CachedGeminiAcpClient).warmPromptSession(
		cwd,
		options.signal,
	);
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
		const run = async () => {
			const earlyStop = createGeminiAcpSearchEarlyStop(onUpdate);
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
			return normalizeGeminiAcpSearchResults(earlyStop.parsedPayload() ?? parseSearchPayload(text));
		};
		return geminiAcpSearchParallelEnabled() ? await run() : await this.enqueue(run);
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		return await this.enqueue(
			async () =>
				// Prompt workflows may depend on the caller/project cwd; only search uses
				// the neutral cwd from searchSessionCwd() to avoid project discovery churn.
				await this.promptOnFreshSession(
					request.cwd ?? process.cwd(),
					requestToParts(request),
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
				await this.ensureIdleSearchSession(active, searchSessionCwd());
			}),
		);
	}

	async warmPromptSession(cwd: string, signal?: AbortSignal): Promise<void> {
		await this.enqueue(() =>
			this.withWarmProcess(signal, async (active) => {
				await this.ensurePromptSession(active, cwd);
			}),
		);
	}

	private async promptOnSearchSession(
		cwd: string,
		text: string,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
		promptSignal?: AbortSignal,
		onProgress?: (phase: "warm" | "session" | "search", message: string) => void,
		searchContext?: { query: string; maxResults: number; model?: string },
	): Promise<string> {
		const processWasWarm = this.active !== undefined;
		return await this.withWarmProcess(signal, async (active) => {
			const model = searchContext?.model ?? "Gemini ACP";
			const query = searchContext?.query ?? "";
			const maxResults = searchContext?.maxResults ?? 4;
			const header = `Executing web search: "${query}" with ${maxResults} max results via ${model}.`;
			onProgress?.(
				"warm",
				`${processWasWarm ? "Using existing warm" : "Started"} ACP process (${model}).`,
			);
			const claim = this.claimSearchSession(active, cwd);
			onProgress?.(
				"session",
				`${claim.reused ? "Reusing warm" : "Creating new"} search session for "${query}" (${maxResults} results).`,
			);
			try {
				if (!claim.reused) {
					onProgress?.("search", `${header}\n\n● Creating search session...`);
				}
				const sessionId = await claim.entry.sessionId;
				onProgress?.("search", geminiBackendProgressText("waiting", header));
				const wrappedOnUpdate = withGeminiBackendProgress(
					onUpdate,
					(message) => onProgress?.("search", message),
					header,
				);

				// Start Gemini prompt
				const promptPromise = active.session.prompt(sessionId, text, wrappedOnUpdate, {
					signal: promptSignal,
					returnTextOnAbort: true,
				});

				try {
					return await promptPromise;
				} finally {
					// No interval to clear - using real events
				}
			} finally {
				claim.entry.busy = false;
			}
		});
	}

	private async ensureIdleSearchSession(active: ActiveProcess, cwd: string): Promise<void> {
		const entries = active.searchSessions.get(cwd) ?? [];
		if (entries.length > 0) return;
		const entry = this.createSearchSession(active, cwd, false);
		await entry.sessionId;
	}

	private claimSearchSession(active: ActiveProcess, cwd: string): SearchSessionClaim {
		const entries = active.searchSessions.get(cwd) ?? [];
		const idle = entries.find((entry) => !entry.busy);
		if (idle) {
			idle.busy = true;
			return { entry: idle, reused: true };
		}
		return {
			entry: this.createSearchSession(active, cwd, true),
			reused: false,
		};
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
		parts: GeminiAcpPromptPart[],
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		return await this.withWarmProcess(signal, async (active) => {
			const sessionId = await this.ensurePromptSession(active, cwd);
			try {
				return await active.session.prompt(sessionId, parts, onUpdate, { signal });
			} catch (error) {
				// Session may have expired or become invalid; evict so the next turn creates a fresh one.
				active.promptSessions.delete(cwd);
				throw error;
			}
		});
	}

	private async ensurePromptSession(active: ActiveProcess, cwd: string): Promise<string> {
		let sessionId = active.promptSessions.get(cwd);
		if (!sessionId) {
			sessionId = active.session.newSession(cwd);
			active.promptSessions.set(cwd, sessionId);
		}
		return await sessionId;
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
			return { session, searchSessions: new Map(), promptSessions: new Map() };
		} catch (error) {
			await session.close();
			throw error;
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.queue.then(operation, operation);
		this.queue = run.catch(() => {
			// fire-and-forget
		});
		return run;
	}

	private scheduleIdleCleanup(): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			void this.close();
		}, this.idleTtlMs);
		this.idleTimer.unref();
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

function abortError(): Error {
	return new DOMException("Gemini ACP request aborted", "AbortError");
}
