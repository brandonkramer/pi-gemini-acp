import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, resolveStoragePaths, type StorageOptions } from "./paths.ts";

export interface StoredResultMetadata {
	responseId: string;
	path: string;
}

export async function storeResult(
	value: unknown,
	options: StorageOptions & { responseId?: string } = {},
): Promise<StoredResultMetadata> {
	const paths = resolveStoragePaths(options);
	await ensureDir(paths.results);
	const responseId = options.responseId ?? randomUUID();
	const filePath = path.join(paths.results, `${responseId}.json`);
	const tmpPath = `${filePath}.tmp.${randomUUID()}`;
	try {
		await writeFile(
			tmpPath,
			JSON.stringify({ responseId, value, createdAt: new Date().toISOString() }, null, 2),
			{ mode: 0o600 },
		);
		await rename(tmpPath, filePath);
	} catch (cause) {
		await rm(tmpPath, { force: true });
		throw cause;
	}
	return { responseId, path: filePath };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is a typed-cast convenience for callers; runtime shape is not validated (would need zod/valibot)
export async function getStoredResult<T = unknown>(
	responseId: string,
	options: StorageOptions = {},
): Promise<{ responseId: string; value: T; path: string }> {
	const paths = resolveStoragePaths(options);
	const filePath = path.join(paths.results, `${responseId}.json`);
	const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
		responseId: string;
		value: T;
	};
	return { responseId: parsed.responseId, value: parsed.value, path: filePath };
}
