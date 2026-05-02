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

/** Minimal subset of the Pi extension command context the handler relies on. */
export interface PiCommandContext {
	hasUI?: boolean;
	ui?: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	signal?: AbortSignal;
}

/** Slash command handler shape expected by the Pi host. */
export type PiCommandHandler = (
	args: string,
	ctx: PiCommandContext,
) => Promise<void>;

/** Options accepted by `pi.registerCommand`, mirroring the host's signature. */
export interface PiCommandOptions {
	description?: string;
	handler: PiCommandHandler;
}

/** Pi host surface needed to register slash commands (host signature: name + options). */
export interface PiCommandRegistrar {
	registerCommand(name: string, options: PiCommandOptions): void;
}

/** Preserves generic schema inference for Gemini command definitions. */
export function defineGeminiCommand<TParameters extends TSchema>(
	command: GeminiCommand<TParameters>,
): GeminiCommand<TParameters> {
	return command;
}
