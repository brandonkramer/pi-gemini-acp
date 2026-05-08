import { loadConfig, recallEnabledFromConfig } from "../config/settings.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import type { StorageOptions } from "../storage/paths.js";
import type { StructuredError } from "../types.js";
import { defaultEmbedder, type Embedder } from "./embedder.js";
import { runLexicalRecall } from "./lexical-recall.js";

/** One semantically similar prior Gemini result returned by recall. */
export interface RecallHit {
	responseId: string;
	tool: string;
	summary: string;
	similarity: number;
	createdAt: string;
	createdAtMs: number;
	model: string;
	inputsSummary?: string;
	matchType?: "exact" | "fts" | "vector";
	recallProvider?: "fts5" | "sqlite-vec";
}

/** Successful local recall payload. */
export interface RecallResult {
	query: string;
	hits: RecallHit[];
	embeddingModel?: string;
	recallProvider: "fts5" | "sqlite-vec";
	totalCandidates: number;
}

/** Options accepted by local FTS and optional vector recall query paths. */
export interface RecallOptions extends StorageOptions {
	query: string;
	k?: number;
	minScore?: number;
	since?: string;
	tool?: string | string[];
	bypassCache?: boolean;
	embedder?: Embedder;
	signal?: AbortSignal;
	now?: number;
}

/** Result shape for local recall, including structured capability errors. */
export type RecallRunResult = RecallResult | { error: StructuredError };

interface VectorCacheEntry {
	model: string;
	dim: number;
	embedding: number[];
}

interface CandidateRow {
	response_id: string;
	distance: number;
	tool: string;
	cache_model?: string;
	created_at: number;
	recall_text: string;
	embedding_model: string;
}

const queryVectorCache = new Map<string, VectorCacheEntry>();
const QUERY_VECTOR_CACHE_LIMIT = 256;
const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_K = 5;
const MAX_K = 20;

/** Searches local FTS recall first, then optional sqlite-vec rows for prior Gemini results. */
export async function runRecall(
	options: RecallOptions,
): Promise<RecallRunResult> {
	const config = await loadConfig({ rootDir: options.rootDir });
	if (!recallEnabledFromConfig(config)) {
		return { error: recallUnavailable("Local recall is disabled.") };
	}
	try {
		const lexical = await runLexicalRecall(options);
		if (lexical.hits.length > 0) {
			return {
				query: options.query,
				hits: lexical.hits,
				recallProvider: "fts5",
				totalCandidates: lexical.totalCandidates,
			};
		}
	} catch {
		/* FTS recall is best-effort; fall through to vector preflight below. */
	}
	const embedder = options.embedder ?? defaultEmbedder();
	const status = await embedder.status({ rootDir: options.rootDir });
	if (!status.available) {
		return {
			error: recallUnavailable(
				status.reason ?? "Semantic recall embedder is unavailable.",
			),
		};
	}
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		if (!db.sqliteVecAvailable) {
			return {
				error: recallUnavailable(
					"sqlite-vec is unavailable, so semantic recall cannot search vectors.",
				),
			};
		}
		const queryVector = await queryEmbedding(options, embedder);
		const rows = queryRows(
			db.db,
			queryVector.embedding,
			candidateLimit(options.k),
		);
		const filters = buildFilters(options);
		const hits = rows
			.map(rowToHit)
			.filter((hit) => hit.similarity >= filters.minScore)
			.filter((hit) => hit.createdAtMs >= filters.sinceMs)
			.filter((hit) => filters.tools.size === 0 || filters.tools.has(hit.tool))
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, clampK(options.k));
		return {
			query: options.query,
			hits,
			embeddingModel: queryVector.model,
			recallProvider: "sqlite-vec",
			totalCandidates: rows.length,
		};
	} catch (cause) {
		return {
			error: {
				code: "GEMINI_ACP_RECALL_QUERY_FAILED",
				phase: "recall_query",
				message:
					cause instanceof Error
						? cause.message
						: "Semantic recall query failed.",
				retryable: true,
				provider: "gemini-acp",
			},
		};
	} finally {
		db.close();
	}
}

function queryRows(
	db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
	embedding: readonly number[],
	limit: number,
): CandidateRow[] {
	return db
		.prepare(
			`SELECT v.response_id, v.distance, c.tool, c.model AS cache_model,
				c.created_at, e.recall_text, e.model AS embedding_model
			FROM embeddings_vec v
			JOIN embeddings e ON e.response_id = v.response_id
			JOIN response_cache c ON c.response_id = v.response_id
			WHERE v.embedding MATCH ? AND k = ?
			ORDER BY v.distance ASC`,
		)
		.all(JSON.stringify(embedding), limit) as CandidateRow[];
}

async function queryEmbedding(
	options: RecallOptions,
	embedder: Embedder,
): Promise<VectorCacheEntry> {
	const cacheKey = `${options.query}`;
	const cached = options.bypassCache
		? undefined
		: queryVectorCache.get(cacheKey);
	if (cached) return cached;
	const embedded = await embedder.embed(options.query, options.signal);
	const entry = {
		model: embedded.model,
		dim: embedded.dim,
		embedding: embedded.embedding,
	};
	if (!options.bypassCache) rememberQueryVector(cacheKey, entry);
	return entry;
}

function rememberQueryVector(key: string, entry: VectorCacheEntry): void {
	queryVectorCache.delete(key);
	queryVectorCache.set(key, entry);
	while (queryVectorCache.size > QUERY_VECTOR_CACHE_LIMIT) {
		const oldest = queryVectorCache.keys().next().value;
		if (!oldest) break;
		queryVectorCache.delete(oldest);
	}
}

function rowToHit(row: CandidateRow): RecallHit {
	return {
		responseId: row.response_id,
		tool: row.tool,
		summary: row.recall_text,
		similarity: distanceToSimilarity(row.distance),
		createdAt: new Date(row.created_at).toISOString(),
		createdAtMs: row.created_at,
		model: row.cache_model ?? row.embedding_model,
		inputsSummary: inputsSummary(row.recall_text),
		matchType: "vector",
		recallProvider: "sqlite-vec",
	};
}

/** Converts sqlite-vec cosine distance into a bounded similarity score. */
export function distanceToSimilarity(distance: number): number {
	return Math.max(0, Math.min(1, 1 - distance));
}

function buildFilters(options: RecallOptions): {
	minScore: number;
	sinceMs: number;
	tools: Set<string>;
} {
	return {
		minScore: clampScore(options.minScore),
		sinceMs: options.since ? Date.parse(options.since) : 0,
		tools: new Set(
			(Array.isArray(options.tool)
				? options.tool
				: options.tool
					? [options.tool]
					: []
			).filter(Boolean),
		),
	};
}

function inputsSummary(recallText: string): string | undefined {
	return recallText
		.split("\n")
		.find((line) => line.startsWith("inputs: "))
		?.slice("inputs: ".length);
}

function candidateLimit(k: number | undefined): number {
	return Math.max(50, clampK(k) * 5);
}

function clampK(k: number | undefined): number {
	return Math.max(1, Math.min(k ?? DEFAULT_K, MAX_K));
}

function clampScore(score: number | undefined): number {
	return Math.max(0, Math.min(score ?? DEFAULT_MIN_SCORE, 1));
}

function recallUnavailable(message: string): StructuredError {
	return {
		code: "GEMINI_ACP_RECALL_UNAVAILABLE",
		phase: "recall_preflight",
		message: `${message} Run /gemini-config recall status for current capability details.`,
		retryable: false,
		provider: "gemini-acp",
	};
}
