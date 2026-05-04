import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
	ensureDir,
	resolveStoragePaths,
	type StorageOptions,
} from "./paths.js";

/** Row stored in the persistent response cache index. */
export interface ResponseCacheRow {
	cacheKey: string;
	responseId: string;
	tool: string;
	model?: string;
	providerHash?: string;
	sourceHash?: string;
	createdAt: number;
	expiresAt?: number;
	hitCount: number;
	lastHitAt?: number;
	bytes?: number;
}

/** Inputs required to insert or replace a response-cache row. */
export interface PutResponseCacheRow {
	cacheKey: string;
	responseId: string;
	tool: string;
	model?: string;
	providerHash?: string;
	sourceHash?: string;
	createdAt?: number;
	expiresAt?: number;
	bytes?: number;
}

/** Summary returned by `/gemini-config cache status`. */
export interface ResponseCacheSummary {
	rowCount: number;
	hitCount: number;
	totalBytes: number;
	oldestCreatedAt?: number;
	oldestCreatedAtIso?: string;
}

/** Thin SQLite wrapper for the response cache database. */
export class ResponseCacheDatabase {
	readonly db: DatabaseSync;

	constructor(filePath: string) {
		this.db = new DatabaseSync(filePath);
		this.migrate();
	}

	lookup(cacheKey: string, now = Date.now()): ResponseCacheRow | undefined {
		const row = this.db
			.prepare("SELECT * FROM response_cache WHERE cache_key = ?")
			.get(cacheKey) as DbCacheRow | undefined;
		if (!row) return undefined;
		if (typeof row.expires_at === "number" && row.expires_at < now) {
			this.delete(cacheKey);
			return undefined;
		}
		this.db
			.prepare(
				"UPDATE response_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?",
			)
			.run(now, cacheKey);
		return mapRow({ ...row, hit_count: row.hit_count + 1, last_hit_at: now });
	}

	put(row: PutResponseCacheRow): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO response_cache
				(cache_key, response_id, tool, model, provider_hash, source_hash, created_at, expires_at, hit_count, last_hit_at, bytes)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT hit_count FROM response_cache WHERE cache_key = ?), 0),
				COALESCE((SELECT last_hit_at FROM response_cache WHERE cache_key = ?), NULL), ?)`,
			)
			.run(
				row.cacheKey,
				row.responseId,
				row.tool,
				row.model ?? null,
				row.providerHash ?? null,
				row.sourceHash ?? null,
				row.createdAt ?? Date.now(),
				row.expiresAt ?? null,
				row.cacheKey,
				row.cacheKey,
				row.bytes ?? null,
			);
	}

	delete(cacheKey: string): void {
		this.db
			.prepare("DELETE FROM response_cache WHERE cache_key = ?")
			.run(cacheKey);
	}

	clear(tool?: string): number {
		const result = tool
			? this.db.prepare("DELETE FROM response_cache WHERE tool = ?").run(tool)
			: this.db.prepare("DELETE FROM response_cache").run();
		return Number(result.changes ?? 0);
	}

	deleteExpired(now = Date.now()): number {
		const result = this.db
			.prepare(
				"DELETE FROM response_cache WHERE expires_at IS NOT NULL AND expires_at < ?",
			)
			.run(now);
		return Number(result.changes ?? 0);
	}

	liveResponseIds(): Set<string> {
		const rows = this.db
			.prepare("SELECT response_id FROM response_cache")
			.all() as Array<{ response_id: string }>;
		return new Set(rows.map((row) => row.response_id));
	}

	summary(): ResponseCacheSummary {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) AS row_count, COALESCE(SUM(hit_count), 0) AS hit_count, COALESCE(SUM(bytes), 0) AS total_bytes, MIN(created_at) AS oldest_created_at FROM response_cache",
			)
			.get() as {
			row_count: number;
			hit_count: number;
			total_bytes: number;
			oldest_created_at?: number;
		};
		return {
			rowCount: row.row_count,
			hitCount: row.hit_count,
			totalBytes: row.total_bytes,
			oldestCreatedAt: row.oldest_created_at,
			oldestCreatedAtIso: row.oldest_created_at
				? new Date(row.oldest_created_at).toISOString()
				: undefined,
		};
	}

	close(): void {
		this.db.close();
	}

	private migrate(): void {
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(`CREATE TABLE IF NOT EXISTS response_cache (
			cache_key TEXT PRIMARY KEY,
			response_id TEXT NOT NULL,
			tool TEXT NOT NULL,
			model TEXT,
			provider_hash TEXT,
			source_hash TEXT,
			created_at INTEGER NOT NULL,
			expires_at INTEGER,
			hit_count INTEGER NOT NULL DEFAULT 0,
			last_hit_at INTEGER,
			bytes INTEGER
		)`);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_response_cache_tool ON response_cache(tool, created_at)",
		);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_response_cache_expires ON response_cache(expires_at)",
		);
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS idx_response_cache_response_id ON response_cache(response_id)",
		);
		this.db.exec("PRAGMA user_version = 1");
	}
}

/** Opens the response cache database, creating parent storage directories first. */
export async function openResponseCacheDb(
	options: StorageOptions = {},
): Promise<ResponseCacheDatabase> {
	const paths = resolveStoragePaths(options);
	await ensureDir(paths.root);
	return new ResponseCacheDatabase(paths.cacheDb);
}

/** Returns the on-disk SQLite cache path for diagnostics and tests. */
export function responseCacheDbPath(options: StorageOptions = {}): string {
	return path.join(resolveStoragePaths(options).root, "cache.db");
}

interface DbCacheRow {
	cache_key: string;
	response_id: string;
	tool: string;
	model?: string;
	provider_hash?: string;
	source_hash?: string;
	created_at: number;
	expires_at?: number;
	hit_count: number;
	last_hit_at?: number;
	bytes?: number;
}

function mapRow(row: DbCacheRow): ResponseCacheRow {
	return {
		cacheKey: row.cache_key,
		responseId: row.response_id,
		tool: row.tool,
		model: row.model,
		providerHash: row.provider_hash,
		sourceHash: row.source_hash,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		hitCount: row.hit_count,
		lastHitAt: row.last_hit_at,
		bytes: row.bytes,
	};
}
