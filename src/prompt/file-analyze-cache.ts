import { readFile, stat } from "node:fs/promises";
import { configFromEnv, loadConfig, withDefaultGeminiAcpConfig } from "../config/settings.js";
import { deriveCacheKey, sha256Hex } from "../storage/cache-key.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import { getStoredResult, storeResult } from "../storage/results.js";
import type { ValidatedAnalyzeFile } from "./file-analyze-validation.js";
import type { FileAnalyzeOptions, FileAnalyzeResult } from "./file-analyze.js";

/** Looks up a validated file-analysis result using file content hashes to avoid stale hits. */
export async function readFileAnalyzeCache(
	options: FileAnalyzeOptions,
	instructions: string,
	files: ValidatedAnalyzeFile[],
): Promise<FileAnalyzeResult | undefined> {
	if (options.bypassCache || process.env.PI_GEMINI_ACP_CACHE === "0") return;
	const key = await fileAnalyzeCacheKey(options, instructions, files);
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		const row = db.lookup(key.cacheKey);
		if (!row) return undefined;
		const stored = await getStoredResult<{ result: FileAnalyzeResult }>(
			row.responseId,
			{ rootDir: options.rootDir },
		);
		return {
			...stored.value.result,
			cacheStatus: {
				hit: true,
				ageMs: Date.now() - row.createdAt,
				cacheKey: key.cacheKey,
			},
		} as FileAnalyzeResult;
	} finally {
		db.close();
	}
}

/** Stores successful file-analysis results in the persistent response cache. */
export async function writeFileAnalyzeCache(
	options: FileAnalyzeOptions,
	instructions: string,
	files: ValidatedAnalyzeFile[],
	result: FileAnalyzeResult,
): Promise<void> {
	if (process.env.PI_GEMINI_ACP_CACHE === "0" || result.error) return;
	const key = await fileAnalyzeCacheKey(options, instructions, files);
	const stored = await storeResult({ result }, { rootDir: options.rootDir });
	const bytes = (await stat(stored.path)).size;
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		db.put({
			cacheKey: key.cacheKey,
			responseId: stored.responseId,
			tool: "gemini_file_analyze",
			providerHash: key.providerHash,
			sourceHash: key.sourceHash,
			bytes,
		});
	} finally {
		db.close();
	}
}

async function fileAnalyzeCacheKey(
	options: FileAnalyzeOptions,
	instructions: string,
	files: ValidatedAnalyzeFile[],
) {
	const config = withDefaultGeminiAcpConfig(
		configFromEnv(await loadConfig({ rootDir: options.rootDir })),
	);
	const sourceHash = sha256Hex(
		(await Promise.all(files.map(fileFingerprint))).join("\n"),
	);
	return deriveCacheKey({
		tool: "gemini_file_analyze",
		inputs: { paths: options.paths, instructions, cwd: options.cwd },
		providerSettings: config.providers?.["gemini-acp"],
		sourceHash,
	});
}

async function fileFingerprint(file: ValidatedAnalyzeFile): Promise<string> {
	return `${file.relativePath}:${file.sizeBytes}:${sha256Hex(await readFile(file.resolvedPath))}`;
}
