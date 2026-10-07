/**
 * @file Shows Gemini's progress during a chat turn: its thoughts as thinking text, and the tools it
 *   runs on its own plus permission notices as separate tool entries (see tool-activity.ts). When
 *   Pi cannot show tool entries, they fall back to lines in the thinking text. Without this a long
 *   turn shows only "Thinking..." while Gemini is working.
 */
import type { GeminiAcpPromptActivity } from "../acp/client.ts";
import type { AssistantMessageBuilder } from "./message-builder.ts";
import { shortTitle, toolLabel, type ToolActivityLog } from "./tool-activity.ts";

const CAPABILITY_LABELS = {
	filesystemRead: "file reads",
	filesystemWrite: "file writes",
	terminal: "terminal commands",
} as const;

/** Returns a handler that renders one turn's activity into `message`. */
export function createActivityRenderer(
	message: AssistantMessageBuilder,
	toolLog?: ToolActivityLog,
): (activity: GeminiAcpPromptActivity) => void {
	const announced = new Map<string, string>();
	const notice = (line: string) =>
		toolLog ? toolLog.notice(line) : message.appendThinkingLine(line);
	return (activity) => {
		switch (activity.type) {
			case "thought":
				message.appendThinking(activity.text);
				return;
			case "tool": {
				if (toolLog) {
					toolLog.tool(activity);
					return;
				}
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
			case "approval_mode":
				notice(
					activity.mode === "yolo"
						? "⚠ Gemini CLI runs in yolo approval mode: it does not ask Pi for permission, so the Gemini ACP permission policy is not applied."
						: "⚠ Gemini CLI runs in auto-edit approval mode: it edits files without asking Pi for permission, so the policy does not apply to edits.",
				);
				break;
			case "permission":
				if (activity.outcome === "cancelled") {
					notice(permissionDeniedLine(activity));
				}
				break;
		}
	};
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
