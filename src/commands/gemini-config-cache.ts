import { openResponseCacheDb } from "../storage/cache-db.js";
import { sweepOrphanedResultBlobs } from "../storage/retention.js";
import type { StorageOptions } from "../storage/paths.js";
import { toolResult } from "../tools/result.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";

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
		const result = {
			action,
			rowCount: summary.rowCount,
			hitCount: summary.hitCount,
			totalBytes: summary.totalBytes,
			oldestCreatedAt: summary.oldestCreatedAtIso,
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
	].join("\n");
}

function cacheClearText(result: GeminiConfigCacheResult): string {
	return [
		`Cleared Gemini response cache${result.tool ? ` for ${result.tool}` : ""}.`,
		`- deleted rows: ${result.deletedRows ?? 0}`,
		`- orphaned blobs removed: ${result.orphanedBlobs ?? 0}`,
	].join("\n");
}
