/** Opt-in metadata-only diagnostics. Never pass prompts, paths, titles, or error messages here. */
import { appendFileSync } from "node:fs";

import { ACP_TOOL_KINDS } from "./tool-kind.ts";

export interface TraceFields {
	connectionId?: number;
	method?: string;
	requestId?: number;
	durationMs?: number;
	inputChars?: number;
	/** Input tokens Gemini CLI reported for a prompt turn (the whole session context it sent). */
	inputTokens?: number;
	code?: number;
	outcome?: "ok" | "error" | "aborted" | "timeout" | "selected" | "cancelled";
	capability?: "filesystemRead" | "filesystemWrite" | "terminal" | "unknown";
	update?: string;
	/** ACP tool kind of a permission request. */
	kind?: string;
}

const METHODS = new Set([
	"initialize",
	"session/new",
	"session/prompt",
	"session/cancel",
	"session/update",
	"session/request_permission",
	"fs/read_text_file",
	"fs/write_text_file",
	"terminal/create",
]);
const UPDATES = new Set([
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
	"usage_update",
	"current_mode_update",
	"available_commands_update",
]);

/** Appends JSONL to a user-selected file, with private permissions on creation. */
export function traceAcp(event: string, fields: TraceFields = {}): void {
	const file = process.env.PI_GEMINI_ACP_TRACE_FILE;
	if (!file) return;
	try {
		appendFileSync(
			file,
			JSON.stringify({
				timestamp: new Date().toISOString(),
				pid: process.pid,
				event,
				...fields,
				method:
					fields.method === undefined
						? undefined
						: METHODS.has(fields.method)
							? fields.method
							: "other",
				kind:
					fields.kind === undefined
						? undefined
						: (ACP_TOOL_KINDS as readonly string[]).includes(fields.kind)
							? fields.kind
							: "other",
				update:
					fields.update === undefined
						? undefined
						: UPDATES.has(fields.update)
							? fields.update
							: "other",
			}) + "\n",
			{ mode: 0o600 },
		);
	} catch {
		// Diagnostics must not break a turn or write anything onto protocol stdout.
	}
}

/** Positive integer overrides only (at most 2^31 - 1); invalid values keep the default. */
export function acpPositiveIntEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback;
}

/** Positive millisecond overrides only; invalid values keep the bounded default. */
export function acpTimeoutMs(name: string, fallback: number): number {
	return acpPositiveIntEnv(name, fallback);
}
