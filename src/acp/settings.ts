import type { GeminiAcpProviderSettings } from "../types.js";
import type { GeminiAcpCommandSettings } from "./client.js";

export function buildGeminiAcpCommandSettings(
	settings: GeminiAcpProviderSettings | undefined,
): GeminiAcpCommandSettings {
	const args = [...(settings?.args ?? ["--acp"])] as string[];
	if (settings?.model && !hasModelArg(args))
		args.push("--model", settings.model);
	return {
		command: settings?.command ?? "gemini",
		args,
		permissionPolicy: settings?.permissionPolicy,
	};
}

export function hasModelArg(args: readonly string[]): boolean {
	return args.some(
		(arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="),
	);
}
