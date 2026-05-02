import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/** Checks whether a configured local ACP command is executable by the current user. */
export type CommandExists = (command: string) => Promise<boolean>;

/** Checks whether a configured Gemini ACP command is executable without spawning the ACP session. */
export async function defaultGeminiAcpCommandExists(
	command: string,
): Promise<boolean> {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (isPathLikeCommand(trimmed)) return isExecutable(trimmed);
	for (const dir of (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)) {
		if (await isExecutable(path.join(dir, trimmed))) return true;
	}
	return false;
}

function isPathLikeCommand(command: string): boolean {
	return (
		path.isAbsolute(command) || command.includes("/") || command.includes("\\")
	);
}

async function isExecutable(candidate: string): Promise<boolean> {
	try {
		await access(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
