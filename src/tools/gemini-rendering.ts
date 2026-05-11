/** @file Shared Gemini tool rendering primitives and title components. */
import { Box, type Component, Text } from "@earendil-works/pi-tui";

import { getCachedToolTitle } from "./cost-estimate.js";
import type { ToolRenderContext, ToolRenderResultOptions } from "./define.js";

interface GeminiTheme {
	fg?: (color: string, text: string) => string;
}

/** Options for a reusable animated Gemini tool title renderer. */
export interface GeminiAnimatedTitleOptions {
	toolName: `gemini_${string}`;
	stateKey?: string;
	donePrefix?: string;
	intervalMs?: number;
}

/** Collapsed and expanded formatting callbacks for a tool display value. */
export interface GeminiDisplayModes<TValue> {
	collapsed: (value: TValue) => string;
	expanded: (value: TValue) => string;
}

/** Shared Ctrl+O hint prefix used by Gemini tool renderers. */
export const CTRL_O_EXPAND_HINT = "Press Ctrl+O to expand tool output";

const DEFAULT_TITLE_INTERVAL_MS = 120;
const TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// These helpers rely on src/tools/define.ts mirroring Pi's
// ToolDefinition.renderCall/renderResult signature. Pi owns context.state,
// lastComponent, and invalidate lifecycles, so keep both files aligned if the
// host renderer contract changes.
/** Renders an animated title while a Gemini tool is partial and a done title after completion. */
export function renderGeminiToolCallTitle<TParams>(
	context: ToolRenderContext<TParams>,
	theme: unknown,
	options: GeminiAnimatedTitleOptions,
): Component {
	const stateKey = options.stateKey ?? `${options.toolName}Title`;
	const activeTitle = titleFromRenderState(context, stateKey, options.toolName);
	if (context.isPartial) {
		if (activeTitle) {
			activeTitle.start();
			return activeTitle;
		}
		const title = new GeminiAnimatedTitleComponent(context.invalidate, theme, options);
		setTitleInRenderState(context, stateKey, title);
		return title;
	}
	activeTitle?.stop();
	setTitleInRenderState(context, stateKey, undefined);
	const cachedTitle = context.toolCallId ? getCachedToolTitle(context.toolCallId) : undefined;
	const doneText = cachedTitle
		? `${options.donePrefix ?? "✓"} ${cachedTitle}`
		: `${options.donePrefix ?? "✓"} ${options.toolName}`;
	return new Text(accentToolText(doneText, theme), 0, 0);
}

/** Wraps text in the same padded Pi box used by Gemini tool result renderers. */
export function boxedToolText(text: string): Box {
	const box = new Box(1, 0);
	box.addChild(new Text(text, 0, 0));
	return box;
}

/** Applies Pi's dim foreground color when the active theme exposes one. */
export function dimToolText(text: string, theme: unknown): string {
	return themeFg(theme, "dim", text);
}

/** Applies Pi's accent foreground color when the active theme exposes one. */
export function accentToolText(text: string, theme: unknown): string {
	return themeFg(theme, "accent", text);
}

/** Formats a consistent Ctrl+O expansion hint. */
export function expandedToolOutputHint(details: string): string {
	return `${CTRL_O_EXPAND_HINT} for ${details}.`;
}

/** Chooses collapsed or expanded text formatting from Pi's render options. */
export function formatCollapsedOrExpanded<TValue>(
	value: TValue,
	options: ToolRenderResultOptions,
	modes: GeminiDisplayModes<TValue>,
): string {
	return options.expanded ? modes.expanded(value) : modes.collapsed(value);
}

/** Safely truncates text without exceeding the requested character count. */
export function truncateToolText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function titleFromRenderState<TParams>(
	context: ToolRenderContext<TParams>,
	stateKey: string,
	toolName: string,
): GeminiAnimatedTitleComponent | undefined {
	const stateTitle = context.state?.[stateKey];
	if (stateTitle instanceof GeminiAnimatedTitleComponent && stateTitle.matches(toolName)) {
		return stateTitle;
	}
	if (
		context.lastComponent instanceof GeminiAnimatedTitleComponent &&
		context.lastComponent.matches(toolName)
	) {
		setTitleInRenderState(context, stateKey, context.lastComponent);
		return context.lastComponent;
	}
	return undefined;
}

function setTitleInRenderState<TParams>(
	context: ToolRenderContext<TParams>,
	stateKey: string,
	title: GeminiAnimatedTitleComponent | undefined,
): void {
	if (!context.state) return;
	const existing = context.state[stateKey];
	if (existing instanceof GeminiAnimatedTitleComponent && existing !== title) {
		existing.dispose();
	}
	if (title) context.state[stateKey] = title;
	else delete context.state[stateKey];
}

function themeFg(theme: unknown, color: string, text: string): string {
	const maybeTheme = theme as GeminiTheme;
	return typeof maybeTheme?.fg === "function" ? maybeTheme.fg(color, text) : text;
}

class GeminiAnimatedTitleComponent implements Component {
	private readonly frames = TITLE_FRAMES;
	private readonly text = new Text("", 0, 0);
	private readonly toolName: string;
	private readonly intervalMs: number;
	private frameIndex = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly requestRender: (() => void) | undefined,
		private readonly theme: unknown,
		options: GeminiAnimatedTitleOptions,
	) {
		this.toolName = options.toolName;
		this.intervalMs = options.intervalMs ?? DEFAULT_TITLE_INTERVAL_MS;
		this.updateText();
		this.start();
	}

	matches(toolName: string): boolean {
		return this.toolName === toolName;
	}

	start(): void {
		if (this.timer || !this.requestRender) return;
		this.timer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.updateText();
			this.requestRender?.();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.stop();
	}

	invalidate(): void {
		this.text.invalidate();
	}

	render(width: number): string[] {
		return this.text.render(width);
	}

	private updateText(): void {
		this.text.setText(
			accentToolText(`${this.frames[this.frameIndex]} ${this.toolName}`, this.theme),
		);
	}
}
