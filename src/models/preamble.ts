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
	});
	return await builder({
		modelId: opts.modelId,
		cwd: opts.cwd,
		upstreamSystemPrompt: opts.upstreamSystemPrompt,
	});
}

/** Static portion of preamble options (expensive parts that rarely change per session). */
interface PreambleBuilderStatic {
	appendSystemPrompt: boolean;
	appendAgents: boolean;
	appendTools: boolean;
	pi: PiToolsSource;
}

/** Per-turn portion of preamble options (cheap parts that may change each turn). */
interface PreambleBuilderTurn {
	modelId: string;
	cwd: string;
	upstreamSystemPrompt?: string;
}

/**
 * Creates a memoized preamble builder. AGENTS.md content is cached by cwd after first read. Tools
 * list is pre-formatted once at creation time (tools rarely change mid-session).
 */
export function createPreambleBuilder(
	staticOpts: PreambleBuilderStatic,
): (turn: PreambleBuilderTurn) => Promise<string> {
	const { appendSystemPrompt, appendAgents, appendTools, pi } = staticOpts;
	// Known assumption: tools don't change mid-session. Dynamic tool registration would
	// require cache invalidation or periodic refresh.
	const toolsList = appendTools ? formatToolsList(pi) : undefined;
	const agentsCache = new Map<string, string | undefined>();

	return async (turn) => {
		const lines: string[] = [];

		if (appendSystemPrompt) {
			lines.push(
				"You are running inside Pi, an AI coding agent CLI.",
				`Model: ${turn.modelId}`,
				`Working directory: ${turn.cwd}`,
				"",
			);
		}

		if (turn.upstreamSystemPrompt) {
			lines.push(turn.upstreamSystemPrompt, "");
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
				lines.push("## Project context (AGENTS.md)", "", agentsContent, "");
			}
		}

		if (toolsList) {
			lines.push("## Available tools", "", toolsList, "");
		}

		return lines.join("\n").trim();
	};
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
function formatToolsList(pi: PiToolsSource): string | undefined {
	const active = pi.getActiveTools?.();
	if (active && active.length > 0) {
		return active.map((name) => `- ${name}`).join("\n");
	}
	const all = pi.getAllTools?.();
	if (all && all.length > 0) {
		return all.map((t) => `- ${t.name}`).join("\n");
	}
	return undefined;
}
