import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface StoragePaths {
	root: string;
	config: string;
	results: string;
	research: string;
}

export interface StorageOptions {
	rootDir?: string;
}

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

export function resolveStoragePaths(
	options: StorageOptions = {},
): StoragePaths {
	const root = path.resolve(expandHome(options.rootDir ?? "~/.pi/gemini-acp"));
	return {
		root,
		config: path.join(root, "config"),
		results: path.join(root, "results"),
		research: path.join(root, "research"),
	};
}

export async function ensureDir(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}
