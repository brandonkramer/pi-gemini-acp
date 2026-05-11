import type { Static, TSchema } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIDialogOptions,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { PiToolShell } from "../types.ts";

/** Executes a Pi slash command with parsed command parameters. */
export type CommandExecute<TParams> = (
	params: TParams,
	ctx?: PiCommandContext,
) => Promise<PiToolShell> | PiToolShell;

/** Completion item returned by Pi slash-command argument completion handlers. */
export type PiCommandCompletion = AutocompleteItem;

/** Supplies argument completions for a Pi slash command. */
export type CommandArgumentCompletions = NonNullable<RegisteredCommand["getArgumentCompletions"]>;

/** Parses a raw Pi slash-command argument string into typed command parameters. */
export type CommandArgumentParser<TParams> = (args: string) => TParams;

/** Public Pi command definition for Gemini ACP slash commands. */
export interface GeminiCommand<TParameters extends TSchema = TSchema> {
	name: `gemini-${string}`;
	description: string;
	parameters: TParameters;
	getArgumentCompletions?: CommandArgumentCompletions;
	parseArgs?: CommandArgumentParser<Static<TParameters>>;
	execute: CommandExecute<Static<TParameters>>;
}

/** Options accepted by Pi UI dialog methods. */
export type PiUIDialogOptions = ExtensionUIDialogOptions;

/** Minimal subset of the real Pi extension command context the handler relies on. */
export type PiCommandContext = Partial<
	Omit<Pick<ExtensionCommandContext, "hasUI" | "signal" | "ui">, "ui">
> & {
	session?: unknown;
	settings?: unknown;
	auth?: unknown;
	ui?: Partial<Pick<ExtensionCommandContext["ui"], "select" | "confirm" | "input" | "notify">>;
};

/** Slash command handler shape expected by the Pi host. */
export type PiCommandHandler = (args: string, ctx: PiCommandContext) => Promise<void>;

/** Options accepted by `pi.registerCommand`, mirroring the host's signature. */
export type PiCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

/** Pi host surface needed to register slash commands (host signature: name + options). */
export type PiCommandRegistrar = Pick<ExtensionAPI, "registerCommand">;

/** Preserves generic schema inference for Gemini command definitions. */
export function defineGeminiCommand<TParameters extends TSchema>(
	command: GeminiCommand<TParameters>,
): GeminiCommand<TParameters> {
	return command;
}
