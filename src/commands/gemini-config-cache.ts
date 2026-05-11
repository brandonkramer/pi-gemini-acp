import { defaultEmbedder } from "../recall/embedder.ts";
import { openResponseCacheDb } from "../storage/cache-db.ts";
import type { StorageOptions } from "../storage/paths.ts";
import { sweepOrphanedResultBlobs } from "../storage/retention.ts";
import { toolResult } from "../tools/result.ts";
import type { PiToolShell, ResultEnvelope } from "../types.ts";

export interface GeminiConfigCacheParams {
	cacheAction?: "status" | "clear";
	tool?: string;
}

export interface GeminiConfigCacheResult {
	action: "status" | "clear";
	rowCount?: number;
	hitCount?: number;
	totalBytes?: number;
	oldestCreatedAt?: string;
	embeddingCount?: number;
	embeddingModels?: string[];
	embeddingQueueDepth?: number;
	embeddingDeadQueueDepth?: number;
	embeddingStaleCount?: number;
	embeddingStatus?: "available" | "unavailable";
	embeddingReason?: string;
	sqliteVecAvailable?: boolean;
	deletedRows?: number;
	orphanedBlobs?: number;
	tool?: string;
}

/** Shows or clears the persistent Gemini response cache. */
export async function runGeminiConfigCache(
	params: GeminiConfigCacheParams = {},
	options: StorageOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigCacheResult>>> {
	const action = params.cacheAction ?? "status";
	const db = await openResponseCacheDb(options);
	try {
		if (action === "clear") {
			const deletedRows = db.clear(params.tool);
			const orphanedBlobs = await sweepOrphanedResultBlobs(
				db.liveResponseIds(),
				undefined,
				options,
			);
			const result = {
				action,
				deletedRows,
				orphanedBlobs,
				tool: params.tool,
			} satisfies GeminiConfigCacheResult;
			return toolResult({ text: cacheClearText(result), data: result });
		}
		const summary = db.summary();
		const embedderStatus = await defaultEmbedder().status(options);
		const embeddings = db.embeddingSummary(embedderStatus.model);
		const result = {
			action,
			rowCount: summary.rowCount,
			hitCount: summary.hitCount,
			totalBytes: summary.totalBytes,
			oldestCreatedAt: summary.oldestCreatedAtIso,
			embeddingCount: embeddings.rowCount,
			embeddingModels: embeddings.models,
			embeddingQueueDepth: embeddings.queueDepth,
			embeddingDeadQueueDepth: embeddings.deadQueueDepth,
			embeddingStaleCount: embeddings.staleCount,
			embeddingStatus: embedderStatus.available ? "available" : "unavailable",
			embeddingReason: embedderStatus.reason,
			sqliteVecAvailable: embeddings.sqliteVecAvailable,
		} satisfies GeminiConfigCacheResult;
		return toolResult({ text: cacheStatusText(result), data: result });
	} finally {
		db.close();
	}
}

function cacheStatusText(result: GeminiConfigCacheResult): string {
	return [
		"Gemini response cache status:",
		`- rows: ${result.rowCount ?? 0}`,
		`- hits: ${result.hitCount ?? 0}`,
		`- bytes: ${result.totalBytes ?? 0}`,
		`- oldest: ${result.oldestCreatedAt ?? "none"}`,
		`- embeddings: ${result.embeddingCount ?? 0} rows; models: ${result.embeddingModels?.join(", ") ?? "none"}; queue: ${result.embeddingQueueDepth ?? 0} (${result.embeddingDeadQueueDepth ?? 0} dead); stale: ${result.embeddingStaleCount ?? 0}`,
		`- sqlite-vec: ${result.sqliteVecAvailable ? "loaded" : "unavailable"}`,
		`- embedder: ${result.embeddingStatus ?? "unavailable"}${result.embeddingReason ? ` (${result.embeddingReason})` : ""}`,
	].join("\n");
}

function cacheClearText(result: GeminiConfigCacheResult): string {
	return [
		`Cleared Gemini response cache${result.tool ? ` for ${result.tool}` : ""}.`,
		`- deleted rows: ${result.deletedRows ?? 0}`,
		`- orphaned blobs removed: ${result.orphanedBlobs ?? 0}`,
	].join("\n");
}
