/** @file Resolves display model labels from settings into valid API model IDs. */
import type { GeminiAcpCommandSettings } from "../acp/client.ts";
import type { GeminiAcpProviderSettings } from "../types.ts";

const API_FALLBACK_MODEL = "gemini-2.5-flash";
const DEFAULT_DISPLAY_LABEL = "Gemini ACP default";

/** Resolves the user-facing model label from provider settings and command arguments. */
export function geminiAcpModelLabel(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
): string {
	return settings?.model?.trim() ?? modelFromArgs(commandSettings.args) ?? DEFAULT_DISPLAY_LABEL;
}

/** Resolves a display model label into a valid API model ID for REST fallback. */
export function apiModelFromLabel(label: string): string {
	return label === DEFAULT_DISPLAY_LABEL ? API_FALLBACK_MODEL : label;
}

function modelFromArgs(args: readonly string[] | undefined): string | undefined {
	if (!args) return undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if ((arg === "--model" || arg === "-m") && args[index + 1]?.trim()) {
			return args[index + 1].trim();
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (value) return value;
		}
	}
	return undefined;
}
