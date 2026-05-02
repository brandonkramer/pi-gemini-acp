import type { Static, TSchema } from "@mariozechner/pi-ai";
import type { PiToolShell } from "../types.js";

/** Executes a Pi slash command with parsed command parameters. */
export type CommandExecute<TParams> = (
	params: TParams,
	signal?: AbortSignal,
) => Promise<PiToolShell> | PiToolShell;

/** Public Pi command definition for Gemini ACP slash commands. */
export interface GeminiCommand<TParameters extends TSchema = TSchema> {
	name: `gemini-${string}`;
	description: string;
	parameters: TParameters;
	execute: CommandExecute<Static<TParameters>>;
}

/** Minimal Pi host surface needed to register slash commands. */
export interface PiCommandRegistrar {
	registerCommand(command: GeminiCommand): void;
}

/** Preserves generic schema inference for Gemini command definitions. */
export function defineGeminiCommand<TParameters extends TSchema>(
	command: GeminiCommand<TParameters>,
): GeminiCommand<TParameters> {
	return command;
}
