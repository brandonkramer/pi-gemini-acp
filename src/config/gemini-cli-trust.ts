import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { isRecord } from "../utils/guards.js";

export const GEMINI_CLI_TRUST_LEVELS = ["TRUST_FOLDER", "TRUST_PARENT", "DO_NOT_TRUST"] as const;

/** Gemini CLI folder-trust level persisted in trustedFolders.json. */
export type GeminiCliTrustLevel = (typeof GEMINI_CLI_TRUST_LEVELS)[number];

/** Result of persisting one exact Gemini CLI trusted folder entry. */
export interface GeminiCliTrustResult {
	folderPath: string;
	trustedFoldersPath: string;
	trustLevel: "TRUST_FOLDER";
}

/** Resolves Gemini CLI's trusted-folder file path using its documented env override. */
export function geminiCliTrustedFoldersPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.GEMINI_CLI_TRUSTED_FOLDERS_PATH?.trim();
	if (configured) return path.resolve(configured);
	return path.join(homedir() || process.cwd(), ".gemini", "trustedFolders.json");
}

/** Persists exact-folder TRUST_FOLDER for Gemini CLI after explicit user consent. */
export async function trustGeminiCliFolder(
	folderPath: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<GeminiCliTrustResult> {
	const trustedFoldersPath = geminiCliTrustedFoldersPath(env);
	const normalizedFolderPath = path.resolve(folderPath);
	const config = await readTrustedFoldersFile(trustedFoldersPath);
	config[normalizedFolderPath] = "TRUST_FOLDER";
	await writeTrustedFoldersFile(trustedFoldersPath, config);
	return {
		folderPath: normalizedFolderPath,
		trustedFoldersPath,
		trustLevel: "TRUST_FOLDER",
	};
}

async function readTrustedFoldersFile(
	trustedFoldersPath: string,
): Promise<Record<string, GeminiCliTrustLevel>> {
	try {
		const parsed = JSON.parse(await readFile(trustedFoldersPath, "utf8"));
		if (!isRecord(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, GeminiCliTrustLevel] =>
				isGeminiCliTrustLevel(entry[1]),
			),
		);
	} catch (cause) {
		if (isNotFoundError(cause)) return {};
		throw cause;
	}
}

async function writeTrustedFoldersFile(
	trustedFoldersPath: string,
	config: Record<string, GeminiCliTrustLevel>,
): Promise<void> {
	await mkdir(path.dirname(trustedFoldersPath), {
		recursive: true,
		mode: 0o700,
	});
	const tempPath = `${trustedFoldersPath}.tmp.${randomUUID()}`;
	await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(tempPath, trustedFoldersPath);
}

function isGeminiCliTrustLevel(value: unknown): value is GeminiCliTrustLevel {
	return (
		typeof value === "string" && (GEMINI_CLI_TRUST_LEVELS as readonly string[]).includes(value)
	);
}

function isNotFoundError(cause: unknown): boolean {
	return isRecord(cause) && cause.code === "ENOENT";
}
