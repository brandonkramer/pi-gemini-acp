import { resolveGitIdentityEnv } from "../config/git-identity.ts";
import { isGeminiAutoModel } from "../config/model-auto.ts";
import type { GeminiAcpProviderSettings } from "../types.ts";
import type { GeminiAcpCommandSettings } from "./client.ts";

export function buildGeminiAcpCommandSettings(
	settings: GeminiAcpProviderSettings | undefined,
	accountEnv?: Record<string, string>,
): GeminiAcpCommandSettings {
	const args = [...(settings?.args ?? ["--acp"])] as string[];
	if (!args.includes("--skip-trust")) args.push("--skip-trust");
	if (settings?.model && !hasModelArg(args)) {
		// Gemini CLI names its routing model plain "auto".
		args.push("--model", isGeminiAutoModel(settings.model) ? "auto" : settings.model);
	}
	return {
		command: settings?.command ?? "gemini",
		args,
		permissionPolicy: settings?.permissionPolicy,
		env: accountEnv,
	};
}

export function hasModelArg(args: readonly string[]): boolean {
	return args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="));
}

/**
 * Adds the git identity effective in `cwd` (repository-local and `includeIf` config apply) to the
 * process environment of a Gemini ACP process that works there. The identity becomes part of the
 * command settings, and therefore of the warm-process cache key: a process started for one identity
 * is not reused in a repository with another. Account environment variables still win.
 */
export function withGitIdentityForCwd(
	settings: GeminiAcpCommandSettings,
	cwd: string,
): GeminiAcpCommandSettings {
	const identity = resolveGitIdentityEnv(process.env, cwd);
	if (Object.keys(identity).length === 0) return settings;
	return { ...settings, env: { ...identity, ...settings.env } };
}
