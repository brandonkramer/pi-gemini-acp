/** @file Warm Gemini ACP client cache for prompt and search workflows. */
import type { SearchResultItem } from "../types.ts";
import { waitForAbort } from "./abort.ts";
import { clientCacheKey } from "./client-cache-key.ts";
import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpConversation,
	GeminiAcpPromptObservers,
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
import { isContextOverflowError } from "./error-classifier.ts";
import { JsonRpcTransportError } from "./jsonrpc-stdio.ts";
import { geminiBackendProgressText, withGeminiBackendProgress } from "./prompt-progress.ts";
import { createGeminiAcpSearchEarlyStop } from "./search-early-stop.ts";
import { geminiAcpSearchParallelEnabled } from "./search-parallel.ts";
import { searchPrompt } from "./search-prompt.ts";
import {
	AcpProcessSession,
	type GeminiAcpProcessSession,
	type GeminiAcpProcessSessionFactory,
} from "./session.ts";
import { acpPositiveIntEnv, traceAcp } from "./trace.ts";

export const DEFAULT_IDLE_TTL_MS = 900_000;
const IDLE_TTL_ENV = "PI_GEMINI_ACP_IDLE_TTL_MS";
/**
 * ACP has no stable way to end a conversation, and every chat turn uses a fresh one, so a warm
 * Gemini process keeps all earlier turns' sessions in memory. Restart it after this many.
 */
export const DEFAULT_MAX_PROMPT_SESSIONS = 25;
const MAX_PROMPT_SESSIONS_ENV = "PI_GEMINI_ACP_MAX_PROMPT_SESSIONS";
/** Continuable chat sessions remembered per process (e.g. several Pi sessions or branches). */
const MAX_CONVERSATIONS = 8;
/**
 * A chat session is not continued once its last turn reported this many input tokens. Gemini CLI
 * keeps its own tool calls and their output in the session, which Pi's history budget does not see,
 * so a continued session can grow until Gemini rejects it (the limit is 1,048,576 tokens). Past
 * this point the next turn starts a fresh session with the budgeted history instead.
 */
export const DEFAULT_MAX_SESSION_INPUT_TOKENS = 600_000;
const MAX_SESSION_INPUT_TOKENS_ENV = "PI_GEMINI_ACP_MAX_SESSION_INPUT_TOKENS";

type CacheRemovalListener = (key: string) => void;

const cacheRemovalListeners = new Set<CacheRemovalListener>();

export type GeminiAcpClientCachePurpose = "search" | "prompt";

interface ActiveProcess {
	session: GeminiAcpProcessSession;
	searchSessions: Map<string, SearchSessionEntry[]>;
	promptSessions: Map<string, Promise<string>>;
	/** Prompt conversations consumed in this process; they are never closed on the Gemini side. */
	promptSessionsUsed: number;
	/** Chat sessions that can continue, most recent last. */
	conversations: ConversationBinding[];
}

/** A Gemini session and the Pi conversation messages it holds, including its own last reply. */
interface ConversationBinding {
	sessionId: string;
	cwd: string;
	contextKey: string;
	seen: readonly string[];
	/** Input tokens Gemini CLI reported for the last turn, when it reported any. */
	inputTokens?: number;
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
	get(
		settings: GeminiAcpCommandSettings,
		_purpose: GeminiAcpClientCachePurpose = "search",
	): GeminiAcpClient {
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

	/** Warms the cached search subprocess and default neutral search session. */
	async warmSearch(
		settings: GeminiAcpCommandSettings,
		options: GeminiAcpClientWarmOptions = {},
	): Promise<void> {
		await this.cachedClient(settings, "search").warmSearchSession(options.signal);
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
export function geminiAcpClientCacheKey(
	settings: GeminiAcpCommandSettings,
	_purpose: GeminiAcpClientCachePurpose,
): string {
	return clientCacheKey(settings);
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

/** Warms the production Gemini ACP prompt cache without sending user-visible work. */
export async function warmCachedGeminiAcpPromptClient(
	settings: GeminiAcpCommandSettings,
	cwd: string,
	options: GeminiAcpClientWarmOptions = {},
): Promise<void> {
	await (defaultCache.get(settings, "prompt") as CachedGeminiAcpClient).warmPromptSession(
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
	// Retain the subprocess before initialize resolves so shutdown can interrupt it.
	private startingSession?: Promise<GeminiAcpProcessSession>;
	private closed = false;
	private retireActiveWhenIdle = false;
	private queue: Promise<unknown> = Promise.resolve();
	private idleTimer?: ReturnType<typeof setTimeout>;
	private activeOperations = 0;
	private removedFromCache = false;

	private readonly settings: GeminiAcpCommandSettings;
	private readonly sessionFactory: GeminiAcpProcessSessionFactory;
	private readonly idleTtlMs: number;
	private readonly removeFromCache: () => void;

	constructor(
		settings: GeminiAcpCommandSettings,
		sessionFactory: GeminiAcpProcessSessionFactory,
		idleTtlMs: number,
		removeFromCache: () => void,
	) {
		this.settings = settings;
		this.sessionFactory = sessionFactory;
		this.idleTtlMs = idleTtlMs;
		this.removeFromCache = removeFromCache;
	}

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
		return geminiAcpSearchParallelEnabled() ? await run() : await this.enqueue(run, signal);
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
		observers?: GeminiAcpPromptObservers,
	): Promise<string> {
		// Prompt workflows may depend on the caller/project cwd; only search uses
		// the neutral cwd from searchSessionCwd() to avoid project discovery churn.
		const cwd = request.cwd ?? process.cwd();
		const conversation = "parts" in request ? request.conversation : undefined;
		return await this.enqueue(
			async () =>
				conversation
					? await this.promptConversation(
							cwd,
							requestToParts(request),
							conversation,
							signal,
							onUpdate,
							observers,
						)
					: await this.promptOnFreshSession(
							cwd,
							requestToParts(request),
							signal,
							onUpdate,
							observers,
						),
			signal,
		);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.clearIdleTimer();
		this.removeFromCacheOnce();
		await this.closeActive();
	}

	async warmSearchSession(signal?: AbortSignal): Promise<void> {
		await this.enqueue(
			() =>
				this.withWarmProcess(signal, async (active) => {
					await waitForAbort(this.ensureIdleSearchSession(active, searchSessionCwd()), signal);
				}),
			signal,
		);
	}

	async warmPromptSession(cwd: string, signal?: AbortSignal): Promise<void> {
		await this.enqueue(
			() =>
				this.withWarmProcess(signal, async (active) => {
					await waitForAbort(this.ensurePromptSession(active, cwd, signal), signal);
				}),
			signal,
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
				const sessionId = await waitForAbort(claim.entry.sessionId, signal);
				onProgress?.("search", geminiBackendProgressText("waiting", header, "search"));
				const wrappedOnUpdate = withGeminiBackendProgress(
					onUpdate,
					(message) => onProgress?.("search", message),
					header,
					"search",
				);

				// Search has two abort sources: the caller/tool cancel signal and the internal
				// early-stop signal fired once a complete JSON result array streams in. Both must
				// cancel the ACP prompt, but only caller cancellation should reject the tool call.
				const promptAbort = mergeAbortSignals(signal, promptSignal);
				try {
					const result = await active.session.prompt(sessionId, text, wrappedOnUpdate, {
						signal: promptAbort.signal,
						returnTextOnAbort: true,
					});
					if (signal?.aborted) throw abortError();
					return result;
				} finally {
					promptAbort.dispose();
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
		observers?: GeminiAcpPromptObservers,
	): Promise<string> {
		return await this.withWarmProcess(signal, async (active) => {
			// Each request already contains Pi's full history; reusing a conversation would
			// append that history repeatedly on the Gemini side.
			const sessionId = await waitForAbort(
				this.claimFreshPromptSession(active, cwd, signal),
				signal,
			);
			return await active.session.prompt(sessionId, parts, onUpdate, { ...observers, signal });
		});
	}

	/**
	 * Continues the session that holds the start of this conversation, sending only the new messages,
	 * or starts a fresh one with the full history. A session whose turn failed or was aborted is not
	 * continued: its state on the Gemini side is unknown. A session that reported too many input
	 * tokens is not continued either. If a continued session overflows Gemini's input limit before
	 * producing any output, the turn is retried once on a fresh session.
	 */
	private async promptConversation(
		cwd: string,
		parts: GeminiAcpPromptPart[],
		conversation: GeminiAcpConversation,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
		observers?: GeminiAcpPromptObservers,
	): Promise<string> {
		return await this.withWarmProcess(signal, async (active) => {
			const binding = claimConversation(
				active,
				cwd,
				conversation,
				acpPositiveIntEnv(MAX_SESSION_INPUT_TOKENS_ENV, DEFAULT_MAX_SESSION_INPUT_TOKENS),
			);
			if (!binding) {
				return await this.promptConversationTurn(active, cwd, parts, conversation, undefined, {
					signal,
					onUpdate,
					observers,
				});
			}
			// Set from callbacks, so an object: a plain `let` looks constant to flow analysis.
			const progress = { produced: false };
			try {
				return await this.promptConversationTurn(
					active,
					cwd,
					conversation.continuationParts(binding.seen.length),
					conversation,
					binding.sessionId,
					{
						signal,
						onUpdate: (chunk) => {
							progress.produced = true;
							return onUpdate?.(chunk);
						},
						observers: {
							...observers,
							onActivity: (activity) => {
								progress.produced = true;
								observers?.onActivity?.(activity);
							},
						},
					},
				);
			} catch (error) {
				// Retrying after Gemini already streamed text or ran tools would repeat them.
				if (progress.produced || signal?.aborted || !isContextOverflowError(error)) throw error;
				traceAcp("conversation.overflow_retry");
				return await this.promptConversationTurn(active, cwd, parts, conversation, undefined, {
					signal,
					onUpdate,
					observers,
				});
			}
		});
	}

	/** One chat turn on `sessionId`, or on a fresh session; remembers the session on success. */
	private async promptConversationTurn(
		active: ActiveProcess,
		cwd: string,
		promptParts: GeminiAcpPromptPart[],
		conversation: GeminiAcpConversation,
		continuedSessionId: string | undefined,
		options: {
			signal?: AbortSignal;
			onUpdate?: GeminiAcpPromptUpdateHandler;
			observers?: GeminiAcpPromptObservers;
		},
	): Promise<string> {
		const { signal, onUpdate, observers } = options;
		const sessionId =
			continuedSessionId ??
			(await waitForAbort(this.claimFreshPromptSession(active, cwd, signal), signal));
		traceAcp(continuedSessionId ? "conversation.continue" : "conversation.new", {
			inputChars: promptParts.reduce(
				(sum, part) => sum + (part.type === "text" ? part.text.length : 0),
				0,
			),
		});
		let inputTokens: number | undefined;
		const text = await active.session.prompt(sessionId, promptParts, onUpdate, {
			...observers,
			onOutcome: (outcome) => {
				inputTokens = outcome.usage?.inputTokens;
				observers?.onOutcome?.(outcome);
			},
			signal,
		});
		active.conversations.push({
			sessionId,
			cwd,
			contextKey: conversation.contextKey,
			seen: [...conversation.transcript, conversation.replyFingerprint(text)],
			inputTokens,
		});
		if (active.conversations.length > MAX_CONVERSATIONS) active.conversations.shift();
		return text;
	}

	/** Takes the prewarmed prompt session for `cwd`, or creates one; each is used for one chat. */
	private claimFreshPromptSession(
		active: ActiveProcess,
		cwd: string,
		signal?: AbortSignal,
	): Promise<string> {
		const pendingSession = this.ensurePromptSession(active, cwd, signal);
		active.promptSessions.delete(cwd);
		active.promptSessionsUsed += 1;
		if (
			active.promptSessionsUsed >=
			acpPositiveIntEnv(MAX_PROMPT_SESSIONS_ENV, DEFAULT_MAX_PROMPT_SESSIONS)
		) {
			// Restart the process once idle so abandoned conversations do not accumulate.
			this.retireActiveWhenIdle = true;
		}
		return pendingSession;
	}

	private async ensurePromptSession(
		active: ActiveProcess,
		cwd: string,
		signal?: AbortSignal,
	): Promise<string> {
		let sessionId = active.promptSessions.get(cwd);
		if (!sessionId) {
			sessionId = active.session.newSession(cwd, signal);
			active.promptSessions.set(cwd, sessionId);
		}
		try {
			return await sessionId;
		} catch (error) {
			if (active.promptSessions.get(cwd) === sessionId) active.promptSessions.delete(cwd);
			throw error;
		}
	}

	private async withWarmProcess<T>(
		signal: AbortSignal | undefined,
		operation: (active: ActiveProcess) => Promise<T>,
	): Promise<T> {
		if (this.closed || signal?.aborted) {
			throw abortError();
		}
		this.clearIdleTimer();
		this.activeOperations += 1;
		let initialized = false;
		try {
			const active = await waitForAbort(this.ensureActive(), signal);
			initialized = true;
			return await operation(active);
		} catch (error) {
			if (
				error instanceof JsonRpcTransportError ||
				(!initialized && signal?.aborted && this.activeOperations === 1)
			) {
				// A dead/timed-out transport cannot serve later turns. An abandoned startup
				// also needs closing, but not while another caller is waiting for it.
				void this.close();
			}
			if (signal?.aborted) throw abortError();
			throw error;
		} finally {
			this.activeOperations = Math.max(0, this.activeOperations - 1);
			if (this.activeOperations === 0) {
				if (this.retireActiveWhenIdle) {
					this.retireActiveWhenIdle = false;
					traceAcp("process.retire");
					void this.closeActive();
				}
				this.scheduleIdleCleanup();
			}
		}
	}

	private ensureActive(): Promise<ActiveProcess> {
		this.active ??= this.createActive().catch((error) => {
			this.active = undefined;
			throw error;
		});
		return this.active;
	}

	private assertOpen(): void {
		if (this.closed) throw abortError();
	}

	private async createActive(): Promise<ActiveProcess> {
		const starting = this.sessionFactory(this.settings);
		this.startingSession = starting;
		const session = await starting;
		try {
			this.assertOpen();
			await session.initialize();
			// Shutdown can close the client while initialize is awaiting a response.
			this.assertOpen();
			return {
				session,
				searchSessions: new Map(),
				promptSessions: new Map(),
				promptSessionsUsed: 0,
				conversations: [],
			};
		} catch (error) {
			await session.close();
			throw error;
		}
	}

	private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const started = performance.now();
		traceAcp("queue.enter");
		const execute = () => {
			if (signal?.aborted || this.closed) throw abortError();
			traceAcp("queue.start", { durationMs: performance.now() - started });
			return operation();
		};
		const run = this.queue.then(execute, execute);
		this.queue = run.catch(() => {
			// Keep ordering even if a waiting caller has already cancelled.
		});
		return waitForAbort(run, signal).catch((error: unknown) => {
			if (signal?.aborted)
				traceAcp("queue.abort", { durationMs: performance.now() - started, outcome: "aborted" });
			throw error;
		});
	}

	private scheduleIdleCleanup(): void {
		this.clearIdleTimer();
		if (this.closed) return;
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
		const starting = this.startingSession;
		this.startingSession = undefined;
		this.active = undefined;
		if (!starting) return;
		try {
			await (await starting).close();
		} catch {
			/* Failed starts are already invalidated; callers get the original error. */
		}
	}
}

/**
 * Removes and returns the binding with the longest history that is a strict prefix of the current
 * transcript, for the same cwd and context. A matching binding whose last turn reported
 * `maxInputTokens` or more is removed without being returned, so the turn starts a fresh session.
 */
function claimConversation(
	active: ActiveProcess,
	cwd: string,
	conversation: GeminiAcpConversation,
	maxInputTokens: number,
): ConversationBinding | undefined {
	let best: ConversationBinding | undefined;
	for (const binding of active.conversations) {
		if (binding.cwd !== cwd || binding.contextKey !== conversation.contextKey) continue;
		if (!isStrictPrefix(binding.seen, conversation.transcript)) continue;
		if (!best || binding.seen.length > best.seen.length) best = binding;
	}
	if (!best) return undefined;
	active.conversations.splice(active.conversations.indexOf(best), 1);
	if (best.inputTokens !== undefined && best.inputTokens >= maxInputTokens) {
		traceAcp("conversation.too_large", { inputTokens: best.inputTokens });
		return undefined;
	}
	return best;
}

function isStrictPrefix(prefix: readonly string[], items: readonly string[]): boolean {
	return prefix.length < items.length && prefix.every((item, index) => items[index] === item);
}

interface MergedAbortSignal {
	signal?: AbortSignal;
	dispose(): void;
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): MergedAbortSignal {
	const presentSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (presentSignals.length === 0) return { dispose: noop };
	if (presentSignals.length === 1) return { signal: presentSignals[0], dispose: noop };

	const controller = new AbortController();
	const disposers: Array<() => void> = [];
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const disposer of disposers) disposer();
		disposers.length = 0;
	};
	const abortFrom = (source: AbortSignal) => {
		dispose();
		controller.abort(source.reason);
	};
	for (const source of presentSignals) {
		if (source.aborted) {
			abortFrom(source);
			return { signal: controller.signal, dispose };
		}
		const abort = () => abortFrom(source);
		source.addEventListener("abort", abort, { once: true });
		disposers.push(() => source.removeEventListener("abort", abort));
	}
	return { signal: controller.signal, dispose };
}

function noop(): void {
	// no-op
}

function notifyGeminiAcpClientCacheEntryRemoved(key: string): void {
	for (const listener of cacheRemovalListeners) listener(key);
}

function abortError(): Error {
	return new DOMException("Gemini ACP request aborted", "AbortError");
}
