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

interface ActiveSession {
	cwd: string;
	session: GeminiAcpProcessSession;
	sessionId: string;
}

interface CachedClientEntry {
	client: CachedGeminiAcpClient;
}

export interface GeminiAcpClientCacheOptions {
	idleTtlMs?: number;
	sessionFactory?: GeminiAcpProcessSessionFactory;
}

/** Short-lived cache for warm Gemini ACP process/session reuse. */
export class GeminiAcpClientCache {
	private readonly entries = new Map<string, CachedClientEntry>();
	private readonly idleTtlMs: number;
	private readonly sessionFactory: GeminiAcpProcessSessionFactory;

	constructor(options: GeminiAcpClientCacheOptions = {}) {
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		this.sessionFactory = options.sessionFactory ?? AcpProcessSession.start;
	}

	/** Returns a cached client keyed by effective command args/capabilities. */
	get(settings: GeminiAcpCommandSettings): GeminiAcpClient {
		const key = cacheKey(settings);
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

/** Returns the process/session-cached Gemini ACP client for production search. */
export function getCachedGeminiAcpClient(
	settings: GeminiAcpCommandSettings,
): GeminiAcpClient {
	return defaultCache.get(settings);
}

/** Closes production cached clients; primarily useful for tests and shutdown hooks. */
export async function closeGeminiAcpClientCache(): Promise<void> {
	await defaultCache.close();
}

class CachedGeminiAcpClient implements GeminiAcpClient {
	private active?: Promise<ActiveSession>;
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
		return this.enqueue(async () => {
			return normalizeGeminiAcpSearchResults(
				parseSearchPayload(
					await this.promptOnWarmSession(
						request.cwd ?? process.cwd(),
						searchPrompt(request),
						signal,
					),
				),
			);
		});
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		return this.enqueue(async () =>
			this.promptOnWarmSession(
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

	private async promptOnWarmSession(
		cwd: string,
		text: string,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
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
			const active = await this.ensureActive(cwd, signal);
			const response = await active.session.prompt(
				active.sessionId,
				text,
				onUpdate,
			);
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

	private async ensureActive(
		cwd: string,
		signal?: AbortSignal,
	): Promise<ActiveSession> {
		const active = await this.active;
		if (active?.cwd === cwd) return active;
		if (active) await this.closeActive();
		this.active = this.createActive(cwd, signal).catch((error) => {
			this.active = undefined;
			throw error;
		});
		return this.active;
	}

	private async createActive(
		cwd: string,
		signal?: AbortSignal,
	): Promise<ActiveSession> {
		const session = await this.sessionFactory(this.settings, signal);
		try {
			await session.initialize();
			return { cwd, session, sessionId: await session.newSession(cwd) };
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

function cacheKey(settings: GeminiAcpCommandSettings): string {
	return JSON.stringify({
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
