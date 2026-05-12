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

/** Builds a Pi-aware preamble string for injection ahead of the user history. */
export async function buildPiPreamble(opts: PreambleOptions): Promise<string> {
	const { appendSystemPrompt, appendAgents, appendTools, upstreamSystemPrompt } = opts;
	const lines: string[] = [];

	if (appendSystemPrompt) {
		lines.push(
			"You are running inside Pi, an AI coding agent CLI.",
			`Model: ${opts.modelId}`,
			`Working directory: ${opts.cwd}`,
			"",
		);
	}

	if (upstreamSystemPrompt) {
		lines.push(upstreamSystemPrompt, "");
	}

	if (appendAgents) {
		const agentsContent = await readAgentsMd(opts.cwd);
		if (agentsContent) {
			lines.push("## Project context (AGENTS.md)", "", agentsContent, "");
		}
	}

	if (appendTools) {
		const toolsList = formatToolsList(opts.pi);
		if (toolsList) {
			lines.push("## Available tools", "", toolsList, "");
		}
	}

	return lines.join("\n").trim();
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
