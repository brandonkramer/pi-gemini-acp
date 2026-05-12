/** @file Chat-preamble configuration subcommand for /gemini-config chat. */
import { loadConfig, saveChatSettings } from "../config/settings.ts";
import type { StorageOptions } from "../storage/paths.ts";
import { toolResult } from "../tools/result.ts";
import type { GeminiAcpChatSettings, PiToolShell, ResultEnvelope } from "../types.ts";
import type { PiCommandContext } from "./define.ts";
import { hasInteractiveUi, type InteractiveCommandContext } from "./picker.ts";

export interface GeminiConfigChatParams {
	chatAction?: "status" | "reset";
	chatFlag?: ChatFlag;
	chatValue?: boolean;
}

export type ChatFlag = "appendSystemPrompt" | "appendAgents" | "appendSkills";

export interface GeminiConfigChatResult {
	appendSystemPrompt: boolean;
	appendAgents: boolean;
	appendSkills: boolean;
	appendSystemPromptOrigin: "default" | "user";
	appendAgentsOrigin: "default" | "user";
	appendSkillsOrigin: "default" | "user";
}

const CHAT_FLAGS: readonly ChatFlag[] = ["appendSystemPrompt", "appendAgents", "appendSkills"];

const DEFAULT_CHAT_SETTINGS: Required<GeminiAcpChatSettings> = {
	appendSystemPrompt: true,
	appendAgents: true,
	appendSkills: true,
};

/** Toggles chat-preamble flags. */
export async function runGeminiConfigChat(
	params: GeminiConfigChatParams = {},
	options: StorageOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigChatResult>>> {
	const config = await loadConfig(options);
	const current = config.providers?.["gemini-acp"]?.chat ?? {};

	if (params.chatAction === "reset") {
		await saveChatSettings({}, options);
		const result = chatResult({});
		return toolResult({ text: chatStatusText(result), data: result });
	}

	if (params.chatFlag && typeof params.chatValue === "boolean") {
		if (!isChatFlag(params.chatFlag)) {
			return toolResult({
				text: `Unknown chat flag "${String(params.chatFlag)}". Valid flags: ${CHAT_FLAGS.join(", ")}.`,
				data: chatResult(current),
			});
		}
		const next: GeminiAcpChatSettings = { ...current, [params.chatFlag]: params.chatValue };
		await saveChatSettings(next, options);
		const result = chatResult(next);
		return toolResult({
			text: `${chatStatusText(result)}\n\nRestart Pi to apply the new chat preamble setting.`,
			data: result,
		});
	}

	const result = chatResult(current);
	return toolResult({ text: chatStatusText(result), data: result });
}

function isChatFlag(value: string): value is ChatFlag {
	return CHAT_FLAGS.includes(value as ChatFlag);
}

function chatResult(chat: GeminiAcpChatSettings): GeminiConfigChatResult {
	return {
		appendSystemPrompt: chat.appendSystemPrompt ?? DEFAULT_CHAT_SETTINGS.appendSystemPrompt,
		appendAgents: chat.appendAgents ?? DEFAULT_CHAT_SETTINGS.appendAgents,
		appendSkills: chat.appendSkills ?? DEFAULT_CHAT_SETTINGS.appendSkills,
		appendSystemPromptOrigin: chat.appendSystemPrompt === undefined ? "default" : "user",
		appendAgentsOrigin: chat.appendAgents === undefined ? "default" : "user",
		appendSkillsOrigin: chat.appendSkills === undefined ? "default" : "user",
	};
}

function chatStatusText(result: GeminiConfigChatResult): string {
	return [
		"Chat preamble:",
		`- appendSystemPrompt: ${onOff(result.appendSystemPrompt)} (${result.appendSystemPromptOrigin})`,
		`- appendAgents:       ${onOff(result.appendAgents)} (${result.appendAgentsOrigin})`,
		`- appendSkills:       ${onOff(result.appendSkills)} (${result.appendSkillsOrigin})`,
	].join("\n");
}

/** Shows an interactive picker for chat-preamble flags when Pi UI is available. */
export async function showGeminiConfigChatPicker(
	ctx: PiCommandContext,
	options: StorageOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigChatResult>>> {
	if (!hasInteractiveUi(ctx)) return await runGeminiConfigChat({}, options);
	return await showInteractiveChatPicker(ctx, options);
}

async function showInteractiveChatPicker(
	ctx: InteractiveCommandContext,
	options: StorageOptions,
): Promise<PiToolShell<ResultEnvelope<GeminiConfigChatResult>>> {
	for (;;) {
		const result = await runGeminiConfigChat({}, options);
		const data = result.details.data;
		const choices = chatChoices(data);
		const picked = await ctx.ui.select("Chat preamble", choices, { signal: ctx.signal });
		if (!picked || picked === "Done") return result;
		if (picked === "Reset to defaults") {
			await runGeminiConfigChat({ chatAction: "reset" }, options);
			continue;
		}

		const flag = choiceToFlag(picked, data);
		if (flag) {
			await runGeminiConfigChat({ chatFlag: flag, chatValue: !data[flag] }, options);
		}
	}
}

function chatChoices(result: GeminiConfigChatResult): string[] {
	return [
		`${checkbox(result.appendSystemPrompt)} Include system prompt header`,
		`${checkbox(result.appendAgents)} Include AGENTS.md from working directory`,
		`${checkbox(result.appendSkills)} Include available skills list`,
		"Reset to defaults",
		"Done",
	];
}

function checkbox(checked: boolean): string {
	return checked ? "[x]" : "[ ]";
}

function choiceToFlag(choice: string, result: GeminiConfigChatResult): ChatFlag | undefined {
	const map: Record<string, ChatFlag | undefined> = {
		[`${checkbox(result.appendSystemPrompt)} Include system prompt header`]: "appendSystemPrompt",
		[`${checkbox(result.appendAgents)} Include AGENTS.md from working directory`]: "appendAgents",
		[`${checkbox(result.appendSkills)} Include available skills list`]: "appendSkills",
	};
	return map[choice];
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}
