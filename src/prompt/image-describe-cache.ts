import { readFile, stat } from "node:fs/promises";

import { configFromEnv, loadConfig, withDefaultGeminiAcpConfig } from "../config/settings.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import { deriveCacheKey } from "../storage/cache-key.js";
import { getStoredResult, storeResult } from "../storage/results.js";
import { sha256Hex } from "../utils/hash.js";
import type { ValidatedImageInput } from "./image-describe-input.js";
import type { ImageDescribeOptions, ImageDescribeResult } from "./image-describe.js";

type ValidatedImagePathInput = Extract<ValidatedImageInput, { kind: "path" }>;

/** Looks up a cached image description after path validation and byte hashing. */
export async function readImageDescribeCache(
	options: ImageDescribeOptions,
	image: ValidatedImagePathInput,
): Promise<ImageDescribeResult | undefined> {
	if (options.bypassCache || process.env.PI_GEMINI_ACP_CACHE === "0") return;
	const key = await imageDescribeCacheKey(options, image);
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		const row = db.lookup(key.cacheKey);
		if (!row) return undefined;
		const stored = await getStoredResult<{ result: ImageDescribeResult }>(row.responseId, {
			rootDir: options.rootDir,
		});
		return {
			...stored.value.result,
			cacheStatus: {
				hit: true,
				ageMs: Date.now() - row.createdAt,
				cacheKey: key.cacheKey,
			},
		} as ImageDescribeResult;
	} finally {
		db.close();
	}
}

/** Stores a successful image description in the persistent response cache. */
export async function writeImageDescribeCache(
	options: ImageDescribeOptions,
	image: ValidatedImagePathInput,
	result: ImageDescribeResult,
): Promise<void> {
	if (process.env.PI_GEMINI_ACP_CACHE === "0" || result.error) return;
	const key = await imageDescribeCacheKey(options, image);
	const stored = await storeResult(
		{
			result,
			recallInputs: {
				imagePath: options.imagePath,
				mode: options.mode,
				instructions: options.instructions,
				cwd: options.cwd,
			},
		},
		{ rootDir: options.rootDir },
	);
	const bytes = (await stat(stored.path)).size;
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		db.put({
			cacheKey: key.cacheKey,
			responseId: stored.responseId,
			tool: "gemini_image_describe",
			providerHash: key.providerHash,
			sourceHash: key.sourceHash,
			bytes,
		});
	} finally {
		db.close();
	}
}

async function imageDescribeCacheKey(
	options: ImageDescribeOptions,
	image: ValidatedImagePathInput,
) {
	const config = withDefaultGeminiAcpConfig(
		configFromEnv(await loadConfig({ rootDir: options.rootDir })),
	);
	const sourceHash = sha256Hex(await readFile(image.resolvedPath));
	return deriveCacheKey({
		tool: "gemini_image_describe",
		inputs: {
			imagePath: options.imagePath,
			mode: options.mode,
			instructions: options.instructions,
			cwd: options.cwd,
		},
		providerSettings: config.providers?.["gemini-acp"],
		sourceHash,
	});
}
