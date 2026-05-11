/** @file Shared path manipulation helpers. */
import { homedir } from "node:os";
import path from "node:path";

/** Expands a leading `~` to the user's home directory. */
export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}
