/** @file Resolves display model labels from settings into valid API model IDs. */
import type { GeminiAcpCommandSettings } from "../acp/client.ts";
import type { GeminiAcpProviderSettings } from "../types.ts";

const API_FALLBACK_MODEL = "gemini-2.5-flash";
const DEFAULT_DISPLAY_LABEL = "Gemini ACP default";
const MODELS_PREFIX = "models/";

/** Resolves the user-facing model label from provider settings and command arguments. */
export function geminiAcpModelLabel(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
): string {
	return settings?.model?.trim() ?? modelFromArgs(commandSettings.args) ?? DEFAULT_DISPLAY_LABEL;
}

/**
 * Resolves a display model label into a valid API model ID for REST fallback.
 *
 * Two normalizations: 1. The display sentinel "Gemini ACP default" maps to the chosen fallback
 * model. 2. Any leading "models/" is stripped — Gemini's REST URL is built as
 * `.../v1beta/models/${modelId}:generateContent`, so a `models/`-prefixed id produces an invalid
 * `.../models/models/...` URL.
 */
export function apiModelFromLabel(label: string): string {
	const resolved = label === DEFAULT_DISPLAY_LABEL ? API_FALLBACK_MODEL : label;
	return resolved.startsWith(MODELS_PREFIX) ? resolved.slice(MODELS_PREFIX.length) : resolved;
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
