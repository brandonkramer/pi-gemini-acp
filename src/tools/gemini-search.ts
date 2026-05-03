import { type Static, Type } from "@mariozechner/pi-ai";
import { Box, type Component, Text } from "@mariozechner/pi-tui";
import {
	runSearch,
	type SearchProgressUpdate,
	type SearchRunResult,
} from "../search/run.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import {
	defineGeminiTool,
	type ToolRenderContext,
	type ToolRenderResultOptions,
	type ToolUpdate,
} from "./define.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpSearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
	maxResults: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Maximum Gemini ACP results.",
		}),
	),
	localDocuments: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.Optional(Type.String()),
				url: Type.String(),
				text: Type.Optional(Type.String()),
				snippet: Type.Optional(Type.String()),
			}),
			{ description: "Optional local/no-key search corpus." },
		),
	),
});

type Params = Static<typeof geminiAcpSearchSchema>;

type ProgressData = { progress: SearchProgressUpdate };

interface GeminiTheme {
	fg?: (color: string, text: string) => string;
}

const SEARCH_TITLE_STATE_KEY = "geminiSearchTitle";

export const geminiAcpSearchTool = defineGeminiTool({
	name: "gemini_search",
	label: "Gemini ACP Search",
	description:
		"Run structured search through configured Gemini ACP, or local documents when provided.",
	parameters: geminiAcpSearchSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		const result = await runSearch(
			params,
			{ onProgress: (update) => emitSearchProgress(update, onUpdate) },
			signal,
		);
		if (result.error) return errorResult(result.error);
		return toolResult({
			text: formatSearchModelPayload(result),
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
	renderCall(_args, theme, context) {
		return renderSearchCallTitle(context, theme);
	},
	renderResult(result, options, theme) {
		return boxedText(dimText(formatSearchToolDisplay(result, options), theme));
	},
});

async function emitSearchProgress(
	update: SearchProgressUpdate,
	onUpdate?: ToolUpdate,
): Promise<void> {
	await onUpdate?.(
		toolResult({
			text: formatSearchProgressContent(update),
			status: "progress",
			data: { progress: update },
			responseId: update.responseId,
		}),
	);
}

function formatSearchToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isProgressData(details.data)) {
		return options.expanded
			? formatSearchProgressExpanded(details.data.progress)
			: formatSearchProgressCollapsed(details.data.progress);
	}
	if (isSearchRunResult(details.data)) {
		return options.expanded
			? formatSearchExpandedDisplay(details.data)
			: formatSearchCollapsedDisplay(details.data);
	}
	return result.content[0]?.text ?? details.error?.message ?? "gemini_search";
}

function renderSearchCallTitle(
	context: ToolRenderContext<Params>,
	theme: unknown,
): Component {
	const activeTitle = titleFromRenderState(context);
	if (context.isPartial) {
		if (activeTitle) {
			activeTitle.start();
			return activeTitle;
		}
		const title = new SearchTitleComponent(context.invalidate, theme);
		setTitleInRenderState(context, title);
		return title;
	}
	activeTitle?.stop();
	setTitleInRenderState(context, undefined);
	return new Text(accentText("✓ gemini_search", theme), 0, 0);
}

function titleFromRenderState(
	context: ToolRenderContext<Params>,
): SearchTitleComponent | undefined {
	const stateTitle = context.state?.[SEARCH_TITLE_STATE_KEY];
	if (stateTitle instanceof SearchTitleComponent) return stateTitle;
	if (context.lastComponent instanceof SearchTitleComponent) {
		setTitleInRenderState(context, context.lastComponent);
		return context.lastComponent;
	}
	return undefined;
}

function setTitleInRenderState(
	context: ToolRenderContext<Params>,
	title: SearchTitleComponent | undefined,
): void {
	if (!context.state) return;
	const existing = context.state[SEARCH_TITLE_STATE_KEY];
	if (existing instanceof SearchTitleComponent && existing !== title) {
		existing.dispose();
	}
	if (title) context.state[SEARCH_TITLE_STATE_KEY] = title;
	else delete context.state[SEARCH_TITLE_STATE_KEY];
}

function boxedText(text: string): Box {
	const box = new Box(1, 0);
	box.addChild(new Text(text, 0, 0));
	return box;
}

function dimText(text: string, theme: unknown): string {
	return themeFg(theme, "dim", text);
}

function accentText(text: string, theme: unknown): string {
	return themeFg(theme, "accent", text);
}

function themeFg(theme: unknown, color: string, text: string): string {
	const maybeTheme = theme as GeminiTheme;
	return typeof maybeTheme?.fg === "function"
		? maybeTheme.fg(color, text)
		: text;
}

function formatSearchProgressContent(update: SearchProgressUpdate): string {
	// Empty/error results intentionally do not emit a separate terminal progress event:
	// Pi marks the final render as non-partial after execute resolves, which stops the
	// spinner through renderCall(context.isPartial=false) while preserving final envelopes.
	return searchProgressLine(update);
}

function formatSearchProgressCollapsed(update: SearchProgressUpdate): string {
	return searchProgressLine(update);
}

function formatSearchProgressExpanded(update: SearchProgressUpdate): string {
	const lines = [
		`gemini_search ${update.phase}`,
		`query: ${update.query}`,
		`message: ${progressMessage(update)}`,
	];
	if (update.provider) lines.push(`provider: ${update.provider}`);
	if (update.model) lines.push(`model: ${update.model}`);
	if (update.resultCount !== undefined)
		lines.push(`resultCount: ${update.resultCount}`);
	if (update.responseId) lines.push(`responseId: ${update.responseId}`);
	if (update.chunk?.text)
		lines.push("latest chunk:", truncateText(update.chunk.text, 800));
	return lines.join("\n");
}

function searchProgressLine(update: SearchProgressUpdate): string {
	if (update.phase === "provider_stream") {
		const latest = update.chunk?.text.trim() || update.message;
		return `Searching: ${truncateText(latest, 220)}`;
	}
	return progressMessage(update);
}

function progressMessage(update: SearchProgressUpdate): string {
	if (update.phase === "provider_stream")
		return "Receiving Gemini ACP search response.";
	return update.message;
}

function formatSearchModelPayload(result: SearchRunResult): string {
	const lines = [
		`Gemini ACP search returned ${result.results.length} result(s).`,
		`provider: ${result.provider}`,
	];
	if (result.model) lines.push(`model: ${result.model}`);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath)
		lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	lines.push("", "Results:");
	if (result.results.length === 0) lines.push("No normalized search results.");
	for (const item of result.results) {
		lines.push(`${item.ranking}. ${item.title}`, `url: ${item.url}`);
		if (item.snippet) lines.push(`snippet: ${item.snippet}`);
	}
	return lines.join("\n");
}

function formatSearchCollapsedDisplay(result: SearchRunResult): string {
	const lines = [
		`Gemini ACP search returned ${result.results.length} result(s).`,
		"Press Ctrl+O to expand tool output for the top result, response ID, and storage details.",
	];
	return lines.join("\n");
}

function formatSearchExpandedDisplay(result: SearchRunResult): string {
	const lines = [
		`Gemini ACP search returned ${result.results.length} result(s).`,
		`provider: ${result.provider}`,
	];
	if (result.model) lines.push(`model: ${result.model}`);
	if (result.responseId) lines.push(`responseId: ${result.responseId}`);
	if (result.fullOutputPath)
		lines.push(`fullOutputPath: ${result.fullOutputPath}`);
	lines.push("", "Results:");
	if (result.results.length === 0) lines.push("No normalized search results.");
	for (const item of result.results) {
		lines.push(`${item.ranking}. ${item.title}`, `   url: ${item.url}`);
		if (item.snippet) lines.push(`   snippet: ${item.snippet}`);
	}
	return lines.join("\n");
}

class SearchTitleComponent implements Component {
	private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private readonly text = new Text("", 0, 0);
	private frameIndex = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly requestRender?: () => void,
		private readonly theme?: unknown,
	) {
		this.updateText();
		this.start();
	}

	start(): void {
		if (this.timer || !this.requestRender) return;
		this.timer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.updateText();
			this.requestRender?.();
		}, 120);
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
			accentText(`${this.frames[this.frameIndex]} gemini_search`, this.theme),
		);
	}
}

function isProgressData(value: unknown): value is ProgressData {
	return isRecord(value) && isSearchProgressUpdate(value.progress);
}

function isSearchProgressUpdate(value: unknown): value is SearchProgressUpdate {
	return (
		isRecord(value) &&
		typeof value.phase === "string" &&
		typeof value.message === "string" &&
		typeof value.query === "string"
	);
}

function isSearchRunResult(value: unknown): value is SearchRunResult {
	return (
		isRecord(value) &&
		(value.provider === "local" || value.provider === "gemini-acp") &&
		Array.isArray(value.results)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
