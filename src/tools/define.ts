import type { Static, TSchema } from "@mariozechner/pi-ai";
import type { Component } from "@mariozechner/pi-tui";
import type { PiToolShell } from "../types.js";

/** Receives partial Pi tool shells emitted while a long-running tool executes. */
export type ToolUpdate = (result: PiToolShell) => void | Promise<void>;

/** Executes a Gemini tool with typed params and optional streaming updates. */
export type ToolExecute<TParams> = (
	toolCallId: string,
	params: TParams,
	signal: AbortSignal,
	onUpdate?: ToolUpdate,
) => Promise<PiToolShell>;

// Mirrors Pi extension runtime ToolDefinition.renderCall/renderResult from
// @mariozechner/pi-coding-agent core/extensions/types.d.ts. Keep this local
// narrow shape in sync with Pi if the host renderer signature changes.
/** Pi renderer state for a tool result or partial progress update. */
export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

/** Minimal render context consumed by this extension's custom renderers. */
export interface ToolRenderContext<TParams = unknown> {
	args?: TParams;
	expanded: boolean;
	isPartial: boolean;
	executionStarted?: boolean;
	invalidate?: () => void;
	lastComponent?: Component;
	state?: Record<string, unknown>;
}

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
export interface GeminiTool<TParameters extends TSchema = TSchema> {
	name: `gemini_${string}`;
	label: string;
	description: string;
	parameters: TParameters;
	execute: ToolExecute<Static<TParameters>>;
	renderCall?: ToolRenderCall<Static<TParameters>>;
	renderResult?: ToolRenderResult;
}

/** Subset of the Pi extension API required to register Gemini tools. */
export interface PiToolRegistrar {
	registerTool(tool: GeminiTool): void;
}

/** Preserves TypeBox parameter inference for standalone Gemini tool objects. */
export function defineGeminiTool<TParameters extends TSchema>(
	tool: GeminiTool<TParameters>,
): GeminiTool<TParameters> {
	return tool;
}
