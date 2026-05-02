import type { Static, TSchema } from "@mariozechner/pi-ai";
import type { PiToolShell } from "../types.js";

export type ToolUpdate = (result: PiToolShell) => void | Promise<void>;

export type ToolExecute<TParams> = (
	toolCallId: string,
	params: TParams,
	signal: AbortSignal,
	onUpdate?: ToolUpdate,
) => Promise<PiToolShell>;

export interface GeminiTool<TParameters extends TSchema = TSchema> {
	name: `gemini_${string}`;
	label: string;
	description: string;
	parameters: TParameters;
	execute: ToolExecute<Static<TParameters>>;
}

export interface PiToolRegistrar {
	registerTool(tool: GeminiTool): void;
}

export function defineGeminiTool<TParameters extends TSchema>(
	tool: GeminiTool<TParameters>,
): GeminiTool<TParameters> {
	return tool;
}
