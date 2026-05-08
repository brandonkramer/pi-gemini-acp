import type { Static, TSchema } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolRenderResultOptions as PiToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { PiToolShell } from "../types.js";

/** Receives partial Pi tool shells emitted while a long-running tool executes. */
export type ToolUpdate = (result: PiToolShell) => void | Promise<void>;

/** Pi execution context used by tools that need interactive confirmation. */
export type ToolExecutionContext = Partial<
	Pick<ExtensionContext, "hasUI" | "ui">
>;

/** Executes a Gemini tool with typed params and optional streaming updates. */
export type ToolExecute<TParams> = (
	toolCallId: string,
	params: TParams,
	signal: AbortSignal,
	onUpdate?: ToolUpdate,
	ctx?: ToolExecutionContext,
) => Promise<PiToolShell>;

type OfficialToolRenderCall = NonNullable<
	ToolDefinition<TSchema>["renderCall"]
>;
type OfficialToolRenderContext<TParams = unknown> =
	Parameters<OfficialToolRenderCall>[2] & { args: TParams };

/** Pi renderer state for a tool result or partial progress update. */
export type ToolRenderResultOptions = PiToolRenderResultOptions;

/** Minimal render context consumed by this extension's custom renderers. */
export type ToolRenderContext<TParams = unknown> = Partial<
	OfficialToolRenderContext<TParams>
> &
	Pick<OfficialToolRenderContext<TParams>, "expanded" | "isPartial">;

/** Renders the tool call title row for Pi's interactive tool UI. */
export type ToolRenderCall<TParams> = (
	args: TParams,
	theme: unknown,
	context: ToolRenderContext<TParams>,
) => Component;

/** Renders tool output for Pi's interactive collapsed/expanded tool UI. */
export type ToolRenderResult = (
	result: PiToolShell,
	options: ToolRenderResultOptions,
	theme: unknown,
	context: ToolRenderContext,
) => Component;

/** Public Gemini-prefixed Pi tool definition used by registration. */
export type GeminiTool<TParameters extends TSchema = TSchema> = Omit<
	ToolDefinition<TParameters>,
	"name" | "execute" | "renderCall" | "renderResult"
> & {
	name: `gemini_${string}`;
	execute: ToolExecute<Static<TParameters>>;
	renderCall?: ToolRenderCall<Static<TParameters>>;
	renderResult?: ToolRenderResult;
};

type AnyGeminiTool = Omit<GeminiTool<TSchema>, "execute" | "renderCall"> & {
	execute: ToolExecute<any>;
	renderCall?: ToolRenderCall<any>;
};

/** Subset of the Pi extension API required to register Gemini tools. */
export interface PiToolRegistrar {
	registerTool(tool: AnyGeminiTool): ReturnType<ExtensionAPI["registerTool"]>;
}

/** Preserves TypeBox parameter inference for standalone Gemini tool objects. */
export function defineGeminiTool<TParameters extends TSchema>(
	tool: GeminiTool<TParameters>,
): GeminiTool<TParameters> {
	return tool;
}
