import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { load as loadSqliteVec } from "sqlite-vec";

import { ensureDir, resolveStoragePaths, type StorageOptions } from "./paths.ts";

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

/** Pending embedding job persisted so crashes do not lose recall work. */
export interface EmbeddingQueueRow {
	responseId: string;
	enqueuedAt: number;
	attempts: number;
	lastError?: string;
	nextAttemptAt?: number;
	deadAt?: number;
}

/** Embedding row and vector to persist for semantic recall. */
export interface PutEmbeddingRow {
	responseId: string;
	tool: string;
	recallText: string;
	model: string;
	embedding: readonly number[];
	embeddedAt?: number;
}

/** Summary of local embedding metadata and queue state. */
export interface EmbeddingSummary {
	rowCount: number;
	models: string[];
	queueDepth: number;
	deadQueueDepth: number;
	sqliteVecAvailable: boolean;
	currentModel?: string;
	staleCount?: number;
}

/** Thin SQLite wrapper for the response cache database. */
export class ResponseCacheDatabase {
	readonly db: DatabaseSync;
	readonly sqliteVecAvailable: boolean;

	constructor(filePath: string) {
		this.db = new DatabaseSync(filePath, { allowExtension: true });
		this.sqliteVecAvailable = this.tryLoadSqliteVec();
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

	responseById(responseId: string): ResponseCacheRow | undefined {
		const row = this.db
			.prepare("SELECT * FROM response_cache WHERE response_id = ?")
			.get(responseId) as DbCacheRow | undefined;
		return row ? mapRow(row) : undefined;
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
		this.db.prepare("DELETE FROM response_cache WHERE cache_key = ?").run(cacheKey);
	}

	clear(tool?: string): number {
		const result = tool
			? this.db.prepare("DELETE FROM response_cache WHERE tool = ?").run(tool)
			: this.db.prepare("DELETE FROM response_cache").run();
		return Number(result.changes ?? 0);
	}

	deleteExpired(now = Date.now()): number {
		const result = this.db
			.prepare("DELETE FROM response_cache WHERE expires_at IS NOT NULL AND expires_at < ?")
			.run(now);
		return Number(result.changes ?? 0);
	}

	liveResponseIds(): Set<string> {
		const rows = this.db.prepare("SELECT response_id FROM response_cache").all() as Array<{
			response_id: string;
		}>;
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

	enqueueEmbedding(responseId: string, now = Date.now()): void {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO embedding_queue
				(response_id, enqueued_at, attempts, next_attempt_at)
				VALUES (?, ?, 0, ?)`,
			)
			.run(responseId, now, now);
	}

	nextEmbeddingJobs(limit: number, now = Date.now()): EmbeddingQueueRow[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM embedding_queue
				WHERE dead_at IS NULL AND COALESCE(next_attempt_at, enqueued_at) <= ?
				ORDER BY enqueued_at ASC LIMIT ?`,
			)
			.all(now, limit) as unknown as DbEmbeddingQueueRow[];
		// oxlint-disable-next-line unicorn/no-array-callback-reference -- mapEmbeddingQueueRow takes one arg
		return rows.map(mapEmbeddingQueueRow);
	}

	markEmbeddingFailure(responseId: string, message: string, now = Date.now()): void {
		const row = this.db
			.prepare("SELECT attempts FROM embedding_queue WHERE response_id = ?")
			.get(responseId) as { attempts: number } | undefined;
		const attempts = (row?.attempts ?? 0) + 1;
		const backoffMs = [1_000, 5_000, 30_000][attempts - 1] ?? 30_000;
		this.db
			.prepare(
				`UPDATE embedding_queue
				SET attempts = ?, last_error = ?, next_attempt_at = ?, dead_at = ?
				WHERE response_id = ?`,
			)
			.run(
				attempts,
				message.slice(0, 1000),
				attempts >= 3 ? null : now + backoffMs,
				attempts >= 3 ? now : null,
				responseId,
			);
	}

	putEmbedding(row: PutEmbeddingRow): void {
		const embeddedAt = row.embeddedAt ?? Date.now();
		this.db
			.prepare(
				`INSERT OR REPLACE INTO embeddings
				(response_id, tool, recall_text, model, dim, embedded_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(row.responseId, row.tool, row.recallText, row.model, row.embedding.length, embeddedAt);
		if (this.sqliteVecAvailable) {
			this.db
				.prepare("INSERT OR REPLACE INTO embeddings_vec(response_id, embedding) VALUES (?, ?)")
				.run(row.responseId, JSON.stringify(row.embedding));
		}
	}

	deleteEmbeddingJob(responseId: string): void {
		this.db.prepare("DELETE FROM embedding_queue WHERE response_id = ?").run(responseId);
	}

	embeddingSummary(currentModel?: string): EmbeddingSummary {
		const base = this.db
			.prepare(
				"SELECT COUNT(*) AS row_count, GROUP_CONCAT(DISTINCT model) AS models FROM embeddings",
			)
			.get() as { row_count: number; models?: string };
		const queue = this.db
			.prepare(
				"SELECT COUNT(*) AS depth, COALESCE(SUM(CASE WHEN dead_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS dead FROM embedding_queue",
			)
			.get() as { depth: number; dead: number };
		const stale = currentModel
			? (
					this.db
						.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE model != ?")
						.get(currentModel) as { count: number }
				).count
			: undefined;
		return {
			rowCount: base.row_count,
			models: base.models ? base.models.split(",").filter(Boolean).toSorted() : [],
			queueDepth: queue.depth,
			deadQueueDepth: queue.dead,
			sqliteVecAvailable: this.sqliteVecAvailable,
			currentModel,
			staleCount: stale,
		};
	}

	close(): void {
		this.db.close();
	}

	private tryLoadSqliteVec(): boolean {
		try {
			this.db.enableLoadExtension(true);
			loadSqliteVec(this.db);
			return true;
		} catch {
			return false;
		} finally {
			try {
				this.db.enableLoadExtension(false);
			} catch {
				/* extension loading may already be disabled by Node */
			}
		}
	}

	private migrate(): void {
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
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
		this.db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_response_cache_response_id_unique ON response_cache(response_id)",
		);
		this.db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
			response_id TEXT PRIMARY KEY REFERENCES response_cache(response_id) ON DELETE CASCADE,
			tool TEXT NOT NULL,
			recall_text TEXT NOT NULL,
			model TEXT NOT NULL,
			dim INTEGER NOT NULL,
			embedded_at INTEGER NOT NULL
		)`);
		if (this.sqliteVecAvailable) {
			this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec USING vec0(
				response_id TEXT PRIMARY KEY,
				embedding FLOAT[768]
			)`);
			this.db.exec(`CREATE TRIGGER IF NOT EXISTS trg_embeddings_delete_vec
				AFTER DELETE ON embeddings BEGIN
					DELETE FROM embeddings_vec WHERE response_id = old.response_id;
				END`);
		}
		this.db.exec(`CREATE TABLE IF NOT EXISTS embedding_queue (
			response_id TEXT PRIMARY KEY REFERENCES response_cache(response_id) ON DELETE CASCADE,
			enqueued_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			next_attempt_at INTEGER,
			dead_at INTEGER
		)`);
		this.db.exec("PRAGMA user_version = 2");
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

interface DbEmbeddingQueueRow {
	response_id: string;
	enqueued_at: number;
	attempts: number;
	last_error?: string;
	next_attempt_at?: number;
	dead_at?: number;
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

function mapEmbeddingQueueRow(row: DbEmbeddingQueueRow): EmbeddingQueueRow {
	return {
		responseId: row.response_id,
		enqueuedAt: row.enqueued_at,
		attempts: row.attempts,
		lastError: row.last_error,
		nextAttemptAt: row.next_attempt_at,
		deadAt: row.dead_at,
	};
}
