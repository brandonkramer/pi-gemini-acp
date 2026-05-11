import { openResponseCacheDb } from "../storage/cache-db.ts";
import type { StorageOptions } from "../storage/paths.ts";
import type { SearchResultItem } from "../types.ts";
import { ftsMatchExpression, normalizeRecallQuery, searchableTokens } from "./query-normalize.ts";
import { buildRecallText } from "./recall-text.ts";

/** Metadata persisted for local lexical recall over cached Gemini results. */
export interface PutLexicalRecallEntry extends StorageOptions {
	responseId: string;
	tool: string;
	inputs: unknown;
	result: unknown;
	now?: number;
}

/** One local FTS/query-cache hit. */
export interface LexicalRecallHit {
	responseId: string;
	tool: string;
	summary: string;
	similarity: number;
	createdAt: string;
	createdAtMs: number;
	model: string;
	inputsSummary?: string;
	matchType: "exact" | "fts";
	recallProvider: "fts5";
}

/** Query options for local FTS/query-cache recall. */
export interface LexicalRecallOptions extends StorageOptions {
	query: string;
	k?: number;
	minScore?: number;
	since?: string;
	tool?: string | string[];
	now?: number;
}

/** Summary of local FTS/query-cache recall state. */
export interface LexicalRecallSummary {
	rowCount: number;
	oldestIndexedAt?: number;
	oldestIndexedAtIso?: string;
}

interface LexicalRecallRow {
	response_id: string;
	tool: string;
	cache_model?: string;
	created_at: number;
	normalized_query: string;
	expanded_query: string;
	recall_text: string;
	tags_json: string;
	entities_json: string;
	rank?: number;
}

const DEFAULT_MIN_SCORE = 0.55;
const DEFAULT_K = 5;
const MAX_K = 20;

/** Indexes a cached tool response for local FTS recall without requiring embeddings. */
export async function upsertLexicalRecallEntry(entry: PutLexicalRecallEntry): Promise<void> {
	const db = await openResponseCacheDb({ rootDir: entry.rootDir });
	try {
		ensureLexicalRecallSchema(db.db);
		const normalized = normalizeRecallQuery(entry.inputs);
		const recallText = buildRecallText({
			tool: entry.tool,
			inputs: entry.inputs,
			result: entry.result,
		});
		db.db
			.prepare(
				`INSERT OR REPLACE INTO lexical_recall
				(response_id, tool, original_query, normalized_query, expanded_query, recall_text, tags_json, entities_json, indexed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				entry.responseId,
				publicRecallToolName(entry.tool),
				normalized.originalQuery,
				normalized.normalizedQuery,
				normalized.expandedQuery,
				recallText,
				JSON.stringify(normalized.tags),
				JSON.stringify(normalized.entities),
				entry.now ?? Date.now(),
			);
	} finally {
		db.close();
	}
}

/** Returns local FTS/query-cache recall status for `/gemini-config recall status`. */
export async function lexicalRecallSummary(
	options: StorageOptions = {},
): Promise<LexicalRecallSummary> {
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		ensureLexicalRecallSchema(db.db);
		const row = db.db
			.prepare(
				"SELECT COUNT(*) AS row_count, MIN(indexed_at) AS oldest_indexed_at FROM lexical_recall",
			)
			.get() as { row_count: number; oldest_indexed_at?: number };
		return {
			rowCount: row.row_count,
			oldestIndexedAt: row.oldest_indexed_at,
			oldestIndexedAtIso: row.oldest_indexed_at
				? new Date(row.oldest_indexed_at).toISOString()
				: undefined,
		};
	} finally {
		db.close();
	}
}

/** Searches cached query/answer text with SQLite FTS5 and deterministic normalization. */
export async function runLexicalRecall(
	options: LexicalRecallOptions,
): Promise<{ hits: LexicalRecallHit[]; totalCandidates: number }> {
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		ensureLexicalRecallSchema(db.db);
		const normalized = normalizeRecallQuery(options.query);
		const filters = buildFilters(options);
		const exactRows = exactQueryRows(db.db, normalized.normalizedQuery);
		const ftsRows = ftsQueryRows(db.db, normalized.expandedQuery, candidateLimit(options.k));
		const tokens = searchableTokens(normalized.expandedQuery);
		const seen = new Map<string, LexicalRecallHit>();
		for (const row of exactRows) {
			rememberHit(seen, rowToHit(row, 1, "exact"));
		}
		for (const row of ftsRows) {
			rememberHit(seen, rowToHit(row, rowScore(row, tokens), "fts"));
		}
		const hits = [...seen.values()]
			.filter((hit) => hit.similarity >= filters.minScore)
			.filter((hit) => hit.createdAtMs >= filters.sinceMs)
			.filter((hit) => filters.tools.size === 0 || filters.tools.has(hit.tool))
			.toSorted((a, b) => b.similarity - a.similarity)
			.slice(0, clampK(options.k));
		return { hits, totalCandidates: seen.size };
	} finally {
		db.close();
	}
}

function ensureLexicalRecallSchema(db: { exec(sql: string): void }): void {
	db.exec(`CREATE TABLE IF NOT EXISTS lexical_recall (
		response_id TEXT PRIMARY KEY REFERENCES response_cache(response_id) ON DELETE CASCADE,
		tool TEXT NOT NULL,
		original_query TEXT NOT NULL,
		normalized_query TEXT NOT NULL,
		expanded_query TEXT NOT NULL,
		recall_text TEXT NOT NULL,
		tags_json TEXT NOT NULL,
		entities_json TEXT NOT NULL,
		indexed_at INTEGER NOT NULL
	)`);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_lexical_recall_query ON lexical_recall(normalized_query)`,
	);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_lexical_recall_tool ON lexical_recall(tool)`);
	db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS lexical_recall_fts USING fts5(
		response_id UNINDEXED,
		original_query,
		normalized_query,
		expanded_query,
		tags_json,
		entities_json,
		recall_text
	)`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_lexical_recall_insert_fts
		AFTER INSERT ON lexical_recall BEGIN
			INSERT INTO lexical_recall_fts(response_id, original_query, normalized_query, expanded_query, tags_json, entities_json, recall_text)
			VALUES (new.response_id, new.original_query, new.normalized_query, new.expanded_query, new.tags_json, new.entities_json, new.recall_text);
		END`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_lexical_recall_delete_fts
		AFTER DELETE ON lexical_recall BEGIN
			DELETE FROM lexical_recall_fts WHERE response_id = old.response_id;
		END`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS trg_lexical_recall_update_fts
		AFTER UPDATE ON lexical_recall BEGIN
			DELETE FROM lexical_recall_fts WHERE response_id = old.response_id;
			INSERT INTO lexical_recall_fts(response_id, original_query, normalized_query, expanded_query, tags_json, entities_json, recall_text)
			VALUES (new.response_id, new.original_query, new.normalized_query, new.expanded_query, new.tags_json, new.entities_json, new.recall_text);
		END`);
}

function exactQueryRows(
	db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
	normalizedQuery: string,
): LexicalRecallRow[] {
	return db
		.prepare(
			`SELECT l.*, c.model AS cache_model, c.created_at
			FROM lexical_recall l
			JOIN response_cache c ON c.response_id = l.response_id
			WHERE l.normalized_query = ?`,
		)
		.all(normalizedQuery) as LexicalRecallRow[];
}

function ftsQueryRows(
	db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
	query: string,
	limit: number,
): LexicalRecallRow[] {
	const match = ftsMatchExpression(query);
	if (!match) return [];
	return db
		.prepare(
			`SELECT l.*, c.model AS cache_model, c.created_at, bm25(lexical_recall_fts) AS rank
			FROM lexical_recall_fts
			JOIN lexical_recall l ON l.response_id = lexical_recall_fts.response_id
			JOIN response_cache c ON c.response_id = l.response_id
			WHERE lexical_recall_fts MATCH ?
			ORDER BY rank LIMIT ?`,
		)
		.all(match, limit) as LexicalRecallRow[];
}

function rowScore(row: LexicalRecallRow, queryTokens: string[]): number {
	const rowTokens = new Set(
		searchableTokens(
			`${row.normalized_query} ${row.expanded_query} ${row.tags_json} ${row.entities_json} ${row.recall_text}`,
		),
	);
	const overlap = queryTokens.filter((token) => rowTokens.has(token)).length;
	const queryCoverage = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
	const indexedQueryTokens = searchableTokens(`${row.normalized_query} ${row.expanded_query}`);
	const indexedCoverage =
		indexedQueryTokens.length > 0
			? indexedQueryTokens.filter((token) => queryTokens.includes(token)).length /
				indexedQueryTokens.length
			: 0;
	const tokenScore = Math.max(queryCoverage, indexedCoverage);
	const rankBoost = row.rank === undefined ? 0 : 1 / (1 + Math.abs(row.rank));
	return Math.max(0, Math.min(0.99, 0.35 + tokenScore * 0.5 + rankBoost * 0.15));
}

function rowToHit(
	row: LexicalRecallRow,
	similarity: number,
	matchType: LexicalRecallHit["matchType"],
): LexicalRecallHit {
	return {
		responseId: row.response_id,
		tool: publicRecallToolName(row.tool),
		summary: row.recall_text,
		similarity,
		createdAt: new Date(row.created_at).toISOString(),
		createdAtMs: row.created_at,
		model: row.cache_model ?? "fts5",
		inputsSummary: inputsSummary(row.recall_text),
		matchType,
		recallProvider: "fts5",
	};
}

function rememberHit(hits: Map<string, LexicalRecallHit>, hit: LexicalRecallHit): void {
	const existing = hits.get(hit.responseId);
	if (!existing || hit.similarity > existing.similarity) hits.set(hit.responseId, hit);
}

function buildFilters(options: LexicalRecallOptions): {
	minScore: number;
	sinceMs: number;
	tools: Set<string>;
} {
	return {
		minScore: clampScore(options.minScore),
		sinceMs: options.since ? Date.parse(options.since) : 0,
		tools: new Set(
			(Array.isArray(options.tool) ? options.tool : options.tool ? [options.tool] : [])
				.filter(Boolean)
				// oxlint-disable-next-line unicorn/no-array-callback-reference -- publicRecallToolName takes one arg
				.map(publicRecallToolName),
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

/** Extracts cacheable source/page snippets from Gemini search results for future extension. */
export function sourceTextForLexicalRecall(result: unknown): string | undefined {
	const record = result as {
		data?: { results?: SearchResultItem[] };
		results?: SearchResultItem[];
		sourceText?: string;
	};
	if (typeof record?.sourceText === "string" && record.sourceText.trim())
		return record.sourceText.trim();
	const results = Array.isArray(record?.results)
		? record.results
		: Array.isArray(record?.data?.results)
			? record.data.results
			: undefined;
	return results
		?.map((item) => [item.title, item.url, item.snippet].filter(Boolean).join(" "))
		.join("\n");
}

function publicRecallToolName(tool: string): string {
	switch (tool) {
		case "gemini_prompt":
		case "gemini_extract":
		case "gemini_summarize":
		case "gemini_translate":
		case "gemini_code_review":
			return "gemini_ask";
		case "gemini_file_analyze":
		case "gemini_image_describe":
			return "gemini_analyze";
		case "gemini_recall":
		case "gemini_get_result":
			return "gemini_results";
		default:
			return tool;
	}
}
