import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	ensureDir,
	resolveStoragePaths,
	type StorageOptions,
} from "./paths.js";

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
	await writeFile(
		filePath,
		JSON.stringify(
			{ responseId, value, createdAt: new Date().toISOString() },
			null,
			2,
		),
		{ mode: 0o600 },
	);
	return { responseId, path: filePath };
}

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
