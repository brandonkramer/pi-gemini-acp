import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { openResponseCacheDb } from "./cache-db.js";
import {
	ensureDir,
	resolveStoragePaths,
	type StorageOptions,
} from "./paths.js";

export interface RetentionSweepResult {
	expiredRows: number;
	orphanedBlobs: number;
	retentionDays: number;
}

const DEFAULT_RETENTION_DAYS = 90;

/** Sweeps expired cache rows and old result blobs that are not referenced by live cache rows. */
export async function sweepResponseCacheRetention(
	options: StorageOptions = {},
): Promise<RetentionSweepResult> {
	const retentionDays = resultRetentionDays();
	const db = await openResponseCacheDb(options);
	try {
		const expiredRows = db.deleteExpired();
		const liveIds = db.liveResponseIds();
		const orphanedBlobs = await sweepOrphanedResultBlobs(
			liveIds,
			retentionDays,
			options,
		);
		return { expiredRows, orphanedBlobs, retentionDays };
	} finally {
		db.close();
	}
}

/** Removes old result blobs that have no live cache row. */
export async function sweepOrphanedResultBlobs(
	liveResponseIds: Set<string>,
	retentionDays = resultRetentionDays(),
	options: StorageOptions = {},
): Promise<number> {
	const paths = resolveStoragePaths(options);
	await ensureDir(paths.results);
	const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const entry of await readdir(paths.results, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const responseId = entry.name.slice(0, -".json".length);
		if (liveResponseIds.has(responseId)) continue;
		const filePath = path.join(paths.results, entry.name);
		const info = await stat(filePath);
		if (info.mtimeMs > cutoff) continue;
		await rm(filePath, { force: true });
		removed += 1;
	}
	return removed;
}

/** Retention window for orphaned result blobs, configurable by environment. */
export function resultRetentionDays(): number {
	const raw = process.env.PI_GEMINI_ACP_RESULT_RETENTION_DAYS;
	const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_RETENTION_DAYS;
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_RETENTION_DAYS;
}
