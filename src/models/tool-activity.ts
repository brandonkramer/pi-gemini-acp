/**
 * @file Shows the tools Gemini runs on its own during a chat turn as separate transcript entries,
 *   the way Pi shows its own tool calls, and names the running tool in Pi's working line. Gemini's
 *   thoughts stay in the thinking block, so hiding thinking no longer hides the tool calls. Entries
 *   are Pi custom entries: they are saved in the session and rendered by the renderer registered
 *   here, but never sent to a model. Pi inserts entries appended while a message streams above that
 *   message, so each finished tool call appears before Gemini's answer.
 */
import { Box, type Component, Text } from "@earendil-works/pi-tui";

import type { GeminiAcpPromptActivity } from "../acp/client.ts";
import type { AcpToolKind } from "../acp/tool-kind.ts";

/** Custom entry type of one Gemini tool call or notice in the session. */
export const GEMINI_TOOL_ENTRY_TYPE = "gemini-acp-tool";

/** Lines of output shown while an entry is collapsed. */
const COLLAPSED_OUTPUT_LINES = 5;
/** Output kept per entry; the session file must not grow with large command output. */
const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_TITLE_CHARS = 160;

const KIND_LABELS: Partial<Record<AcpToolKind, string>> = {
	read: "Read",
	edit: "Edit",
	delete: "Delete",
	move: "Move",
	search: "Search",
	execute: "Shell",
	fetch: "Fetch",
	switch_mode: "Mode",
};

/** Saved data of a {@link GEMINI_TOOL_ENTRY_TYPE} entry. */
export interface GeminiToolEntryData {
	/**
	 * `completed`/`failed`: a finished tool call; `unfinished`: still running when the turn ended;
	 * `notice`: a message about permissions, in `title`.
	 */
	status: "completed" | "failed" | "unfinished" | "notice";
	kind?: AcpToolKind;
	title?: string;
	output?: string;
	/** Set when `output` holds only the end of a longer output. */
	outputTruncated?: boolean;
	/** Absent when Pi saw only the end of the call. */
	durationMs?: number;
}

/** The parts of Pi's extension API used here; all optional so older hosts degrade gracefully. */
export interface ToolActivityApi {
	appendEntry?: (customType: string, data?: unknown) => void;
	registerEntryRenderer?: (
		customType: string,
		renderer: (
			entry: { data?: unknown },
			options: { expanded: boolean },
			theme: unknown,
		) => Component | undefined,
	) => void;
	on?: (
		event: "agent_start" | "agent_end",
		handler: (event: unknown, ctx: ToolActivityContext) => void,
	) => void;
}

interface ToolActivityContext {
	hasUI?: boolean;
	ui?: { setWorkingMessage?: (message?: string) => void };
}

interface ToolActivityHost {
	appendEntry: (customType: string, data: GeminiToolEntryData) => void;
	setWorkingMessage: (message?: string) => void;
}

let host: ToolActivityHost | undefined;

/**
 * Registers the entry renderer and remembers how to add entries and set the working line. Without
 * `appendEntry` (an older Pi, or a test double) chat turns keep showing tools as thinking text.
 */
export function installToolActivityHost(pi: ToolActivityApi): void {
	const appendEntry = pi.appendEntry;
	if (typeof appendEntry !== "function") {
		host = undefined;
		return;
	}
	pi.registerEntryRenderer?.(GEMINI_TOOL_ENTRY_TYPE, (entry, options, theme) =>
		renderGeminiToolEntry(entry.data as GeminiToolEntryData, options.expanded, theme),
	);
	let ui: ToolActivityContext["ui"];
	pi.on?.("agent_start", (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
	});
	pi.on?.("agent_end", () => {
		ui?.setWorkingMessage?.();
		ui = undefined;
	});
	host = {
		appendEntry: (customType, data) => appendEntry.call(pi, customType, data),
		setWorkingMessage: (message) => ui?.setWorkingMessage?.(message),
	};
}

/** Forgets the installed host. For tests. */
export function resetToolActivityHost(): void {
	host = undefined;
}

/** Returns the tool log for one chat turn, or `undefined` when Pi cannot show tool entries. */
export function createToolActivityLog(): ToolActivityLog | undefined {
	return host ? new ToolActivityLog(host) : undefined;
}

interface RunningCall {
	kind?: AcpToolKind;
	title?: string;
	startedAt?: number;
}

/** Collects one turn's tool calls and adds an entry for each as it finishes. */
export class ToolActivityLog {
	private readonly host: ToolActivityHost;
	private readonly running = new Map<string, RunningCall>();
	private steps = 0;

	constructor(activityHost: ToolActivityHost) {
		this.host = activityHost;
	}

	/** Handles a `tool` activity: tracks the call while it runs and saves it when it ends. */
	tool(activity: Extract<GeminiAcpPromptActivity, { type: "tool" }>): void {
		const id = activity.toolCallId ?? "";
		let call = this.running.get(id);
		if (!call) {
			this.steps += 1;
			call =
				activity.status === "completed" || activity.status === "failed"
					? {}
					: { startedAt: performance.now() };
		}
		call.kind = activity.kind ?? call.kind;
		call.title = activity.title ?? call.title;
		if (activity.status === "completed" || activity.status === "failed") {
			this.running.delete(id);
			this.save(call, activity.status, activity.output);
			this.host.setWorkingMessage(`Gemini · step ${this.steps} · thinking`);
			return;
		}
		this.running.set(id, call);
		this.host.setWorkingMessage(
			`Gemini · step ${this.steps} · ${toolLabel(call.kind, call.title)}`,
		);
	}

	/** Saves a message about permissions as its own entry. */
	notice(text: string): void {
		this.host.appendEntry(GEMINI_TOOL_ENTRY_TYPE, { status: "notice", title: text });
	}

	/** Saves calls that never reported an end and restores Pi's working line. */
	finish(): void {
		for (const call of this.running.values()) this.save(call, "unfinished");
		this.running.clear();
		this.host.setWorkingMessage();
	}

	private save(
		call: RunningCall,
		status: "completed" | "failed" | "unfinished",
		output?: string,
	): void {
		const kept = keepOutput(output);
		this.host.appendEntry(GEMINI_TOOL_ENTRY_TYPE, {
			status,
			kind: call.kind,
			title: call.title,
			...kept,
			durationMs:
				call.startedAt === undefined ? undefined : Math.round(performance.now() - call.startedAt),
		});
	}
}

/** One-line label of a tool call, such as `Shell: git status`. */
export function toolLabel(kind: AcpToolKind | undefined, title: string | undefined): string {
	const label = (kind && KIND_LABELS[kind]) ?? "Tool";
	const line = shortTitle(title);
	return line ? `${label}: ${line}` : label;
}

/** Collapses a tool title to one line of at most MAX_TITLE_CHARS characters. */
export function shortTitle(title: string | undefined): string | undefined {
	const line = title?.replaceAll(/\s+/gu, " ").trim();
	if (!line) return undefined;
	return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
}

function keepOutput(
	output: string | undefined,
): Pick<GeminiToolEntryData, "output" | "outputTruncated"> {
	const trimmed = output?.replace(/\s+$/u, "");
	if (!trimmed) return {};
	let lines = trimmed.split("\n");
	let truncated = false;
	if (lines.length > MAX_OUTPUT_LINES) {
		lines = lines.slice(-MAX_OUTPUT_LINES);
		truncated = true;
	}
	let text = lines.join("\n");
	if (text.length > MAX_OUTPUT_CHARS) {
		text = text.slice(-MAX_OUTPUT_CHARS);
		truncated = true;
	}
	return truncated ? { output: text, outputTruncated: true } : { output: text };
}

interface EntryTheme {
	fg?: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
}

/** Renders a saved Gemini tool entry like Pi's own tool calls: command, output, duration. */
export function renderGeminiToolEntry(
	data: GeminiToolEntryData | undefined,
	expanded: boolean,
	theme: unknown,
): Component | undefined {
	if (!data || typeof data.status !== "string") return undefined;
	const t = theme as EntryTheme | undefined;
	const fg = (color: string, text: string) => t?.fg?.(color, text) ?? text;
	const bold = (text: string) => t?.bold?.(text) ?? text;
	const background =
		data.status === "failed"
			? "toolErrorBg"
			: data.status === "completed"
				? "toolSuccessBg"
				: "toolPendingBg";
	const box = new Box(1, 1, t?.bg ? (text) => t.bg?.(background, text) ?? text : undefined);

	if (data.status === "notice") {
		box.addChild(new Text(fg("warning", data.title ?? ""), 0, 0));
		return box;
	}

	const header =
		data.kind === "execute" && data.title
			? `$ ${data.title}`
			: `Gemini ${toolLabel(data.kind, data.title)}`;
	const lines = [fg("toolTitle", bold(header))];

	const output = data.output ? data.output.split("\n") : [];
	if (output.length > 0) {
		lines.push("");
		const hidden = expanded ? 0 : Math.max(0, output.length - COLLAPSED_OUTPUT_LINES);
		if (hidden > 0) {
			lines.push(fg("dim", `... (${hidden} earlier lines, ctrl+o to expand)`));
		} else if (data.outputTruncated) {
			lines.push(fg("dim", "... (earlier output not kept)"));
		}
		for (const line of output.slice(hidden)) lines.push(fg("toolOutput", line));
	}

	const footer = entryFooter(data);
	if (footer) {
		lines.push("");
		lines.push(
			data.status === "failed"
				? fg("error", footer)
				: data.status === "unfinished"
					? fg("warning", footer)
					: fg("dim", footer),
		);
	}
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
}

function entryFooter(data: GeminiToolEntryData): string | undefined {
	const took =
		data.durationMs === undefined ? undefined : `Took ${(data.durationMs / 1000).toFixed(1)}s`;
	if (data.status === "failed") return took ? `Failed · ${took}` : "Failed";
	if (data.status === "unfinished") return "Did not finish before the turn ended";
	return took;
}
