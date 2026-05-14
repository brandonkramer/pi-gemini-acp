/** @file Pi-aware preamble builder for Gemini ACP prompts. */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Minimal shape needed from Pi to enumerate active tools. */
export interface PiToolsSource {
	getActiveTools?: () => string[];
	getAllTools?: () => Array<{ name: string }>;
}

/** Options for building the Pi-aware prompt preamble. */
export interface PreambleOptions {
	modelId: string;
	cwd: string;
	appendSystemPrompt: boolean;
	appendAgents: boolean;
	appendTools: boolean;
	pi: PiToolsSource;
	upstreamSystemPrompt?: string;
	maxSystemPromptChars?: number;
	maxToolNames?: number;
}

const AGENTS_MAX_BYTES = 32_768;
const AGENTS_FILE = "AGENTS.md";

/**
 * Builds a Pi-aware preamble string for injection ahead of the user history.
 *
 * @deprecated For production chat paths, use createPreambleBuilder() to avoid re-reading AGENTS.md
 *   on every turn. This unmemoized form is kept for tests and one-off callers.
 */
export async function buildPiPreamble(opts: PreambleOptions): Promise<string> {
	const builder = createPreambleBuilder({
		appendSystemPrompt: opts.appendSystemPrompt,
		appendAgents: opts.appendAgents,
		appendTools: opts.appendTools,
		pi: opts.pi,
		maxToolNames: opts.maxToolNames,
	});
	return await builder({
		modelId: opts.modelId,
		cwd: opts.cwd,
		upstreamSystemPrompt: opts.upstreamSystemPrompt,
		maxSystemPromptChars: opts.maxSystemPromptChars,
	});
}

/** Static portion of preamble options (expensive parts that rarely change per session). */
interface PreambleBuilderStatic {
	appendSystemPrompt: boolean;
	appendAgents: boolean;
	appendTools: boolean;
	pi: PiToolsSource;
	maxSystemPromptChars?: number;
	maxToolNames?: number;
}

/** Per-turn portion of preamble options (cheap parts that may change each turn). */
interface PreambleBuilderTurn {
	modelId: string;
	cwd: string;
	upstreamSystemPrompt?: string;
	maxSystemPromptChars?: number;
}

/**
 * Creates a memoized preamble builder. AGENTS.md content is cached by cwd after first read. Tools
 * list is formatted lazily on the first turn (not during builder creation), because Pi action APIs
 * such as getActiveTools throw when called during the extension-loading phase.
 */
export function createPreambleBuilder(
	staticOpts: PreambleBuilderStatic,
): (turn: PreambleBuilderTurn) => Promise<string> {
	const { appendSystemPrompt, appendAgents, appendTools, maxSystemPromptChars, maxToolNames, pi } =
		staticOpts;
	// Known assumption: tools don't change mid-session. Dynamic tool registration would
	// require cache invalidation or periodic refresh.
	let toolsList: string | undefined;
	let toolsListResolved = false;
	const agentsCache = new Map<string, string | undefined>();

	return async (turn) => {
		const lines: string[] = [];

		if (appendSystemPrompt) {
			lines.push(`Pi coding agent m=${turn.modelId} cwd=${turn.cwd}`, "");
		}

		if (turn.upstreamSystemPrompt) {
			lines.push(
				clampText(turn.upstreamSystemPrompt, turn.maxSystemPromptChars ?? maxSystemPromptChars),
				"",
			);
		}

		if (appendAgents) {
			// has() disambiguates "not yet read" from "read and found empty/missing".
			// Known limitation: once cached per cwd, AGENTS.md is never re-read. Edits during
			// a Pi session require a Pi reload to be picked up.
			let agentsContent = agentsCache.get(turn.cwd);
			if (agentsContent === undefined && !agentsCache.has(turn.cwd)) {
				agentsContent = await readAgentsMd(turn.cwd);
				agentsCache.set(turn.cwd, agentsContent);
			}
			if (agentsContent) {
				lines.push("AGENTS.md:", agentsContent, "");
			}
		}

		if (appendTools) {
			if (!toolsListResolved) {
				toolsList = formatToolsList(pi, maxToolNames);
				toolsListResolved = true;
			}
			if (toolsList) {
				lines.push(toolsList, "");
			}
		}

		return lines.join("\n").trim();
	};
}

function clampText(text: string, maxChars?: number): string {
	return maxChars !== undefined && maxChars >= 0 && text.length > maxChars
		? `${text.slice(0, maxChars)}…`
		: text;
}

/** Reads AGENTS.md from cwd, capped at ~32 KB. */
async function readAgentsMd(cwd: string): Promise<string | undefined> {
	try {
		const content = await readFile(path.resolve(cwd, AGENTS_FILE), "utf8");
		const trimmed = content.trim();
		if (!trimmed) return undefined;
		return truncateUtf8(trimmed, AGENTS_MAX_BYTES);
	} catch {
		return undefined;
	}
}

/** Truncates text to a byte limit without splitting multi-byte UTF-8 codepoints. */
function truncateUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) {
		end -= 1;
	}
	return buf.subarray(0, end).toString("utf8") + "\n\n[truncated]";
}

/** Formats the active tools list from Pi's registrar. */
function formatToolsList(pi: PiToolsSource, maxToolNames?: number): string | undefined {
	const active = pi.getActiveTools?.();
	if (active && active.length > 0) return formatToolNames(active, maxToolNames);
	const all = pi.getAllTools?.();
	if (all && all.length > 0)
		return formatToolNames(
			all.map((t) => t.name),
			maxToolNames,
		);
	return undefined;
}

function formatToolNames(names: string[], maxToolNames?: number): string | undefined {
	if (names.length === 0) return undefined;
	const limit = maxToolNames === undefined || maxToolNames < 0 ? names.length : maxToolNames;
	const visible = names.slice(0, limit);
	const hidden = names.length - visible.length;
	const label = hidden > 0 ? `Tools(+${hidden}):` : "Tools:";
	return `${label} ${visible.join(", ")}`;
}
