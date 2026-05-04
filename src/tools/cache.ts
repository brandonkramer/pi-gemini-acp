import { stat } from "node:fs/promises";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import type { Embedder } from "../recall/embedder.js";
import {
	enqueueEmbeddingJob,
	scheduleEmbeddingQueueDrain,
} from "../recall/queue.js";
import { runRecall, type RecallHit } from "../recall/recall.js";
import { deriveCacheKey } from "../storage/cache-key.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import { getStoredResult, storeResult } from "../storage/results.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";

/** Visible cache marker attached to cached Gemini tool results. */
export interface CacheStatus {
	hit: boolean;
	source?: "exact" | "recall";
	ageMs?: number;
	cacheKey?: string;
	warning?: string;
	similarity?: number;
	responseId?: string;
}

export interface ToolCacheOptions<TData> {
	toolName: `gemini_${string}`;
	inputs: unknown;
	rootDir?: string;
	model?: string;
	ttlMs?: number;
	enabledByDefault?: boolean;
	bypassCache?: boolean;
	useCache?: boolean;
	useRecall?: boolean;
	bypassRecall?: boolean;
	recallQuery?: string;
	recallThreshold?: number;
	recallMaxAgeMs?: number;
	recallEmbedder?: Embedder;
	sourceHash?: string;
	execute: () => Promise<PiToolShell<ResultEnvelope<TData>>>;
}

interface CachedShell<TData> {
	shell: PiToolShell<ResultEnvelope<TData>>;
	recallInputs?: unknown;
}

/** Runs a Gemini tool through the persistent response cache without making cache failures fatal. */
export async function withToolResponseCache<TData extends object | null>(
	options: ToolCacheOptions<TData>,
): Promise<PiToolShell<ResultEnvelope<TData>>> {
	if (!isCacheEnabled(options)) return await options.execute();
	const key = await toolCacheKey(options);
	let lookupWarning: string | undefined;
	if (!options.bypassCache) {
		try {
			const db = await openResponseCacheDb({ rootDir: options.rootDir });
			try {
				const row = db.lookup(key.cacheKey);
				if (row) {
					const cached = await getStoredResult<CachedShell<TData>>(
						row.responseId,
						{ rootDir: options.rootDir },
					);
					return withCacheStatus(cached.value.shell, {
						hit: true,
						source: "exact",
						ageMs: Date.now() - row.createdAt,
						cacheKey: key.cacheKey,
					});
				}
			} finally {
				db.close();
			}
		} catch (cause) {
			lookupWarning = cacheWarning(cause);
		}
	}
	const recalled = await recallShortCircuit<TData>(options);
	if (recalled) return recalled;
	const fresh = await options.execute();
	if (fresh.details.status === "error") {
		return lookupWarning
			? withCacheStatus(fresh, { hit: false, warning: lookupWarning })
			: fresh;
	}
	try {
		const stored = await storeResult(
			{
				shell: fresh,
				recallInputs: stripCacheControls(options.inputs),
			} satisfies CachedShell<TData>,
			{ rootDir: options.rootDir },
		);
		const bytes = (await stat(stored.path)).size;
		const db = await openResponseCacheDb({ rootDir: options.rootDir });
		try {
			db.put({
				cacheKey: key.cacheKey,
				responseId: stored.responseId,
				tool: options.toolName,
				model: options.model,
				providerHash: key.providerHash,
				sourceHash: key.sourceHash,
				expiresAt: expiresAt(options.ttlMs),
				bytes,
			});
		} finally {
			db.close();
		}
		await enqueueEmbeddingJob({
			responseId: stored.responseId,
			rootDir: options.rootDir,
		});
		scheduleEmbeddingQueueDrain({ rootDir: options.rootDir });
	} catch {
		return withCacheStatus(fresh, {
			hit: false,
			warning: "Response cache write failed; live result returned.",
		});
	}
	return lookupWarning
		? withCacheStatus(fresh, { hit: false, warning: lookupWarning })
		: fresh;
}

/** Adds cache metadata and a visible marker without changing the underlying tool data shape. */
export function withCacheStatus<TData extends object | null>(
	shell: PiToolShell<ResultEnvelope<TData>>,
	cacheStatus: CacheStatus,
): PiToolShell<ResultEnvelope<TData>> {
	const data = shell.details.data;
	const dataWithStatus =
		data && typeof data === "object"
			? ({ ...data, cacheStatus } as TData)
			: data;
	const prefix = cacheStatus.hit
		? cacheStatus.source === "recall"
			? `[recall hit, similarity ${(cacheStatus.similarity ?? 0).toFixed(2)}, age ${formatAge(cacheStatus.ageMs ?? 0)}, responseId ${cacheStatus.responseId ?? "unknown"}]`
			: `[cache: hit, age ${formatAge(cacheStatus.ageMs ?? 0)}]`
		: cacheStatus.warning
			? `[cache: ${cacheStatus.warning}]`
			: undefined;
	return {
		...shell,
		content: prefix
			? [{ type: "text", text: `${prefix}\n${shell.content[0]?.text ?? ""}` }]
			: shell.content,
		details: {
			...shell.details,
			data: dataWithStatus,
		},
	};
}

async function recallShortCircuit<TData extends object | null>(
	options: ToolCacheOptions<TData>,
): Promise<PiToolShell<ResultEnvelope<TData>> | undefined> {
	if (!options.useRecall || options.bypassRecall || !options.recallQuery)
		return undefined;
	const result = await runRecall({
		query: options.recallQuery,
		k: 1,
		minScore: recallThreshold(options),
		tool: options.toolName,
		rootDir: options.rootDir,
		embedder: options.recallEmbedder,
	});
	if ("error" in result) return undefined;
	const hit = result.hits.find((candidate) =>
		isFreshRecallHit(candidate, options),
	);
	if (!hit) return undefined;
	try {
		const cached = await getStoredResult<CachedShell<TData>>(hit.responseId, {
			rootDir: options.rootDir,
		});
		if (!cached.value.shell) return undefined;
		return withCacheStatus(cached.value.shell, {
			hit: true,
			source: "recall",
			ageMs: Date.now() - hit.createdAtMs,
			similarity: hit.similarity,
			responseId: hit.responseId,
		});
	} catch {
		return undefined;
	}
}

function isFreshRecallHit(
	hit: RecallHit,
	options: ToolCacheOptions<unknown>,
): boolean {
	return Date.now() - hit.createdAtMs <= recallMaxAgeMs(options);
}

function recallThreshold(options: ToolCacheOptions<unknown>): number {
	const configured = Number(process.env.PI_GEMINI_ACP_RECALL_THRESHOLD);
	return Number.isFinite(configured)
		? configured
		: (options.recallThreshold ?? 0.85);
}

function recallMaxAgeMs(options: ToolCacheOptions<unknown>): number {
	const configured = Number(process.env.PI_GEMINI_ACP_RECALL_MAX_AGE_MS);
	if (Number.isFinite(configured) && configured >= 0) return configured;
	return options.recallMaxAgeMs ?? options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
}

async function toolCacheKey(options: ToolCacheOptions<unknown>) {
	const config = withDefaultGeminiAcpConfig(
		configFromEnv(await loadConfig({ rootDir: options.rootDir })),
	);
	return deriveCacheKey({
		tool: options.toolName,
		inputs: stripCacheControls(options.inputs),
		model: options.model,
		providerSettings: config.providers?.["gemini-acp"],
		sourceHash: options.sourceHash,
	});
}

function isCacheEnabled(options: ToolCacheOptions<unknown>): boolean {
	if (process.env.PI_GEMINI_ACP_CACHE === "0") return false;
	return options.enabledByDefault === false
		? options.useCache === true
		: options.useCache !== false;
}

function stripCacheControls(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const {
		bypassCache: _bypass,
		useCache: _use,
		useRecall: _recall,
		bypassRecall: _bypassRecall,
		...rest
	} = value as Record<string, unknown>;
	return rest;
}

function expiresAt(ttlMs: number | undefined): number | undefined {
	return ttlMs === undefined ? undefined : Date.now() + ttlMs;
}

function cacheWarning(cause: unknown): string {
	return cause instanceof Error
		? `Response cache unavailable: ${cause.message}`
		: "Response cache unavailable.";
}

function formatAge(ageMs: number): string {
	if (ageMs < 60_000) return `${Math.max(0, Math.round(ageMs / 1000))}s`;
	if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
	if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h`;
	return `${Math.round(ageMs / 86_400_000)}d`;
}
