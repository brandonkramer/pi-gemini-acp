/** @file Chat-preamble configuration subcommand for /gemini-config chat. */
import { clearChatSettings, loadConfig, saveChatSettings } from "../config/settings.ts";
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

export type ChatFlag = "appendSystemPrompt" | "appendAgents" | "appendTools" | "maxHistoryMessages";

export interface GeminiConfigChatResult {
	appendSystemPrompt: boolean;
	appendAgents: boolean;
	appendTools: boolean;
	maxHistoryMessages: number | undefined;
	maxHistoryMessageChars: number | undefined;
	maxSystemPromptChars: number | undefined;
	maxToolNames: number | undefined;
	appendSystemPromptOrigin: "default" | "user";
	appendAgentsOrigin: "default" | "user";
	appendToolsOrigin: "default" | "user";
	maxHistoryMessagesOrigin: "default" | "user";
	maxHistoryMessageCharsOrigin: "default" | "user";
	maxSystemPromptCharsOrigin: "default" | "user";
	maxToolNamesOrigin: "default" | "user";
}

const DEFAULT_CHAT_SETTINGS: Required<
	Pick<GeminiAcpChatSettings, "appendSystemPrompt" | "appendAgents" | "appendTools">
> &
	Pick<
		GeminiAcpChatSettings,
		"maxHistoryMessages" | "maxHistoryMessageChars" | "maxSystemPromptChars" | "maxToolNames"
	> = {
	appendSystemPrompt: false,
	appendAgents: false,
	appendTools: false,
	maxHistoryMessages: 1,
	maxHistoryMessageChars: 80,
	maxSystemPromptChars: 32,
	maxToolNames: 32,
};

/** Toggles chat-preamble flags. */
export async function runGeminiConfigChat(
	params: GeminiConfigChatParams = {},
	options: StorageOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigChatResult>>> {
	const config = await loadConfig(options);
	const current = config.providers?.["gemini-acp"]?.chat ?? {};

	if (params.chatAction === "reset") {
		await clearChatSettings(options, config);
		const result = chatResult({});
		return toolResult({ text: chatStatusText(result), data: result });
	}

	if (params.chatFlag && typeof params.chatValue === "boolean") {
		const next: GeminiAcpChatSettings = { ...current, [params.chatFlag]: params.chatValue };
		await saveChatSettings(next, options, config);
		const result = chatResult(next);
		return toolResult({
			text: `${chatStatusText(result)}\n\nRestart Pi to apply the new chat preamble setting.`,
			data: result,
		});
	}

	const result = chatResult(current);
	return toolResult({ text: chatStatusText(result), data: result });
}

function chatResult(chat: GeminiAcpChatSettings): GeminiConfigChatResult {
	return {
		appendSystemPrompt: chat.appendSystemPrompt ?? DEFAULT_CHAT_SETTINGS.appendSystemPrompt,
		appendAgents: chat.appendAgents ?? DEFAULT_CHAT_SETTINGS.appendAgents,
		appendTools: chat.appendTools ?? DEFAULT_CHAT_SETTINGS.appendTools,
		maxHistoryMessages: chat.maxHistoryMessages ?? DEFAULT_CHAT_SETTINGS.maxHistoryMessages,
		maxHistoryMessageChars:
			chat.maxHistoryMessageChars ?? DEFAULT_CHAT_SETTINGS.maxHistoryMessageChars,
		maxSystemPromptChars: chat.maxSystemPromptChars ?? DEFAULT_CHAT_SETTINGS.maxSystemPromptChars,
		maxToolNames: chat.maxToolNames ?? DEFAULT_CHAT_SETTINGS.maxToolNames,
		appendSystemPromptOrigin: chat.appendSystemPrompt === undefined ? "default" : "user",
		appendAgentsOrigin: chat.appendAgents === undefined ? "default" : "user",
		appendToolsOrigin: chat.appendTools === undefined ? "default" : "user",
		maxHistoryMessagesOrigin: chat.maxHistoryMessages === undefined ? "default" : "user",
		maxHistoryMessageCharsOrigin: chat.maxHistoryMessageChars === undefined ? "default" : "user",
		maxSystemPromptCharsOrigin: chat.maxSystemPromptChars === undefined ? "default" : "user",
		maxToolNamesOrigin: chat.maxToolNames === undefined ? "default" : "user",
	};
}

function chatStatusText(result: GeminiConfigChatResult): string {
	return [
		"Chat preamble:",
		`- appendSystemPrompt: ${onOff(result.appendSystemPrompt)} (${result.appendSystemPromptOrigin})`,
		`- appendAgents:       ${onOff(result.appendAgents)} (${result.appendAgentsOrigin})`,
		`- appendTools:        ${onOff(result.appendTools)} (${result.appendToolsOrigin})`,
		`- maxHistoryMessages: ${result.maxHistoryMessages ?? "unlimited"} (${result.maxHistoryMessagesOrigin})`,
		`- maxHistoryMessageChars: ${result.maxHistoryMessageChars ?? "unlimited"} (${result.maxHistoryMessageCharsOrigin})`,
		`- maxSystemPromptChars: ${result.maxSystemPromptChars ?? "unlimited"} (${result.maxSystemPromptCharsOrigin})`,
		`- maxToolNames: ${result.maxToolNames ?? "unlimited"} (${result.maxToolNamesOrigin})`,
	].join("\n");
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
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
		const entries = chatChoiceEntries(data);
		const labels = [...entries.map((e) => e.label), "Reset to defaults", "Done"];
		const picked = await ctx.ui.select("Chat preamble", labels, { signal: ctx.signal });
		if (!picked || picked === "Done") return result;
		if (picked === "Reset to defaults") {
			await runGeminiConfigChat({ chatAction: "reset" }, options);
			continue;
		}

		const index = labels.indexOf(picked);
		if (index >= 0 && index < entries.length) {
			const flag = entries[index].flag;
			await runGeminiConfigChat({ chatFlag: flag, chatValue: !data[flag] }, options);
		}
	}
}

interface ChatChoiceEntry {
	flag: ChatFlag;
	label: string;
}

function chatChoiceEntries(result: GeminiConfigChatResult): ChatChoiceEntry[] {
	return [
		{
			flag: "appendSystemPrompt",
			label: `${checkbox(result.appendSystemPrompt)} Include system prompt header`,
		},
		{
			flag: "appendAgents",
			label: `${checkbox(result.appendAgents)} Include AGENTS.md from working directory`,
		},
		{ flag: "appendTools", label: `${checkbox(result.appendTools)} Include available tools list` },
	];
}

function checkbox(checked: boolean): string {
	return checked ? "[x]" : "[ ]";
}
