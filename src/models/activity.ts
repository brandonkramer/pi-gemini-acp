/**
 * @file Shows Gemini's progress during a chat turn as thinking text in Pi: its thoughts, the tools
 *   it runs on its own, and permission requests that Pi's policy denied. Without this a long turn
 *   shows only "Thinking..." while Gemini is working.
 */
import type { GeminiAcpPromptActivity } from "../acp/client.ts";
import type { AcpToolKind } from "../acp/tool-kind.ts";
import type { AssistantMessageBuilder } from "./message-builder.ts";

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

const CAPABILITY_LABELS = {
	filesystemRead: "file reads",
	filesystemWrite: "file writes",
	terminal: "terminal commands",
} as const;

/** Returns a handler that renders one turn's activity into `message`. */
export function createActivityRenderer(
	message: AssistantMessageBuilder,
): (activity: GeminiAcpPromptActivity) => void {
	const announced = new Map<string, string>();
	return (activity) => {
		switch (activity.type) {
			case "thought":
				message.appendThinking(activity.text);
				return;
			case "tool": {
				const id = activity.toolCallId ?? "";
				const title = shortTitle(activity.title) ?? announced.get(id);
				if (!announced.has(id) || !id) {
					announced.set(id, title ?? "");
					message.appendThinkingLine(`▸ ${toolLabel(activity.kind, title)}`);
				}
				if (activity.status === "failed") {
					message.appendThinkingLine(`✗ Failed: ${toolLabel(activity.kind, title)}`);
				}
				return;
			}
			case "permission":
				if (activity.outcome === "cancelled") {
					message.appendThinkingLine(permissionDeniedLine(activity));
				}
				break;
		}
	};
}

function toolLabel(kind: AcpToolKind | undefined, title: string | undefined): string {
	const label = (kind && KIND_LABELS[kind]) ?? "Tool";
	return title ? `${label}: ${title}` : label;
}

function permissionDeniedLine(
	activity: Extract<GeminiAcpPromptActivity, { type: "permission" }>,
): string {
	const title = shortTitle(activity.title);
	const what = title ? ` (${title})` : "";
	if (activity.capability) {
		return `✗ Denied by the Gemini ACP permission policy, which does not allow ${CAPABILITY_LABELS[activity.capability]}${what}. Use /gemini-config permissions to change it.`;
	}
	return `✗ Denied: Gemini asked to run a ${activity.kind ?? "unknown"} tool${what}, which the Gemini ACP permission policy does not cover.`;
}

function shortTitle(title: string | undefined): string | undefined {
	const line = title?.replaceAll(/\s+/gu, " ").trim();
	if (!line) return undefined;
	return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
}
