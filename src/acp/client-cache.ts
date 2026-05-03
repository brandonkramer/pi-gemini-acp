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
} from "./client.js";
import { searchPrompt } from "./search-prompt.js";
import {
	AcpProcessSession,
	type GeminiAcpProcessSession,
	type GeminiAcpProcessSessionFactory,
} from "./session.js";

const DEFAULT_IDLE_TTL_MS = 120_000;

export type GeminiAcpClientCachePurpose = "search" | "prompt";

interface ActiveProcess {
	session: GeminiAcpProcessSession;
	searchSessionIds: Map<string, string>;
}

interface CachedClientEntry {
	client: CachedGeminiAcpClient;
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
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
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
				if (this.entries.get(key)?.client === client) this.entries.delete(key);
			},
		);
		this.entries.set(key, { client });
		return client;
	}

	/** Closes every warm ACP subprocess currently retained by this cache. */
	async close(): Promise<void> {
		const clients = [...this.entries.values()].map((entry) => entry.client);
		this.entries.clear();
		await Promise.all(clients.map((client) => client.close()));
	}
}

const defaultCache = new GeminiAcpClientCache();

/** Returns the process-cached Gemini ACP client for production workflows. */
export function getCachedGeminiAcpClient(
	settings: GeminiAcpCommandSettings,
	purpose: GeminiAcpClientCachePurpose = "search",
): GeminiAcpClient {
	return defaultCache.get(settings, purpose);
}

/** Closes production cached clients; primarily useful for tests and shutdown hooks. */
export async function closeGeminiAcpClientCache(): Promise<void> {
	await defaultCache.close();
}

class CachedGeminiAcpClient implements GeminiAcpClient {
	private active?: Promise<ActiveProcess>;
	private queue: Promise<unknown> = Promise.resolve();
	private idleTimer?: ReturnType<typeof setTimeout>;
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
	): Promise<SearchResultItem[]> {
		return this.enqueue(async () =>
			normalizeGeminiAcpSearchResults(
				parseSearchPayload(
					await this.promptOnSearchSession(
						request.cwd ?? process.cwd(),
						searchPrompt(request),
						signal,
					),
				),
			),
		);
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		return this.enqueue(async () =>
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

	private async promptOnSearchSession(
		cwd: string,
		text: string,
		signal?: AbortSignal,
	): Promise<string> {
		return this.withWarmProcess(signal, async (active) => {
			let sessionId = active.searchSessionIds.get(cwd);
			if (!sessionId) {
				sessionId = await active.session.newSession(cwd);
				active.searchSessionIds.set(cwd, sessionId);
			}
			return active.session.prompt(sessionId, text);
		});
	}

	private async promptOnFreshSession(
		cwd: string,
		text: string,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		return this.withWarmProcess(signal, async (active) => {
			const sessionId = await active.session.newSession(cwd);
			return active.session.prompt(sessionId, text, onUpdate);
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
			if (keepWarm && !signal?.aborted) this.scheduleIdleCleanup();
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
			return { session, searchSessionIds: new Map() };
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
