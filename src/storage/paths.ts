import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expandHome } from "../utils/paths.js";

export interface StoragePaths {
	root: string;
	config: string;
	results: string;
	research: string;
	cacheDb: string;
}

export interface StorageOptions {
	rootDir?: string;
}

export function resolveStoragePaths(options: StorageOptions = {}): StoragePaths {
	const root = path.resolve(expandHome(options.rootDir ?? "~/.pi/gemini-acp"));
	return {
		root,
		config: path.join(root, "config"),
		results: path.join(root, "results"),
		research: path.join(root, "research"),
		cacheDb: path.join(root, "cache.db"),
	};
}

export async function ensureDir(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}
