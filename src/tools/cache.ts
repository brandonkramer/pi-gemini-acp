import { stat } from "node:fs/promises";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import { deriveCacheKey } from "../storage/cache-key.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import { getStoredResult, storeResult } from "../storage/results.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";

/** Visible cache marker attached to cached Gemini tool results. */
export interface CacheStatus {
	hit: boolean;
	ageMs?: number;
	cacheKey?: string;
	warning?: string;
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
	sourceHash?: string;
	execute: () => Promise<PiToolShell<ResultEnvelope<TData>>>;
}

interface CachedShell<TData> {
	shell: PiToolShell<ResultEnvelope<TData>>;
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
	const fresh = await options.execute();
	if (fresh.details.status === "error") {
		return lookupWarning
			? withCacheStatus(fresh, { hit: false, warning: lookupWarning })
			: fresh;
	}
	try {
		const stored = await storeResult(
			{ shell: fresh } satisfies CachedShell<TData>,
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
		? `[cache: hit, age ${formatAge(cacheStatus.ageMs ?? 0)}]`
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
