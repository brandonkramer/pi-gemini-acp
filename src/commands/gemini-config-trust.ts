import { configureGeminiAcpSettings } from "../config/configure-acp.ts";
import { DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS, loadConfig } from "../config/settings.ts";
import { errorResult, toolResult } from "../tools/result.ts";
import type { PiToolShell, ResultEnvelope } from "../types.ts";
import type { PiCommandContext } from "./define.ts";
import type { GeminiConfigAcpCommandOptions } from "./gemini-config-command.ts";
import { hasInteractiveUi, type InteractiveCommandContext } from "./picker.ts";

const SKIP_TRUST_ARG = "--skip-trust";

/** Result returned after configuring Gemini CLI workspace trust for ACP sessions. */
export interface GeminiConfigTrustResult {
	trusted: boolean;
	command: string;
	args: string[];
	reason: string;
}

/** Adds Gemini CLI's session-scoped trust flag after an explicit user confirmation. */
export async function runGeminiConfigTrust(
	ctx?: PiCommandContext,
	options: GeminiConfigAcpCommandOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigTrustResult | { cancelled: true } | null>>> {
	if (hasInteractiveUi(ctx)) {
		const confirmed = await confirmTrustCurrentFolder(ctx);
		if (!confirmed) {
			return toolResult({
				text: "Cancelled. Gemini ACP was not told to trust this folder, so ACP-backed tools may stop if the Gemini CLI refuses or warns about the untrusted workspace.",
				data: { cancelled: true },
				status: "needs_attention",
			});
		}
	}

	const current = await loadCurrentCommand(options);
	const args = current.args.includes(SKIP_TRUST_ARG)
		? current.args
		: [...current.args, SKIP_TRUST_ARG];
	const result = await configureGeminiAcpSettings({ command: current.command, args }, options);
	if ("error" in result) return errorResult(result.error);

	return toolResult({
		text: "Gemini ACP trust enabled for local ACP sessions by adding --skip-trust to the Gemini command args. Gemini CLI receives the folder as session context only when an ACP-backed workflow needs a Gemini session; Pi still keeps ACP filesystem/terminal capabilities disabled unless you enable them separately.",
		data: {
			trusted: true,
			command: result.settings.command ?? current.command,
			args: result.settings.args ?? args,
			reason:
				"Prevents Gemini CLI untrusted-folder diagnostics from corrupting ACP JSON-RPC stdout when ACP-backed tools start a local session.",
		},
	});
}

async function confirmTrustCurrentFolder(ctx: InteractiveCommandContext): Promise<boolean> {
	return await ctx.ui.confirm(
		"Trust this folder for Gemini ACP?",
		[
			"Gemini ACP starts a local Gemini CLI session and must pass a working folder as session context.",
			"Some Gemini CLI versions warn or stop when the folder is not trusted; if that warning appears on stdout, it breaks ACP JSON-RPC and the tool fails before translation/search can run.",
			"If you approve, this extension will add --skip-trust to the configured Gemini ACP args. This trusts the current workspace for each Gemini CLI ACP session, but does not grant filesystem or terminal capabilities in Pi; those remain controlled by /gemini-config permissions.",
			"If you decline, the tool stops so Gemini ACP is not run against an untrusted folder.",
		].join("\n\n"),
		{ signal: ctx.signal },
	);
}

async function loadCurrentCommand(
	options: GeminiConfigAcpCommandOptions,
): Promise<{ command: string; args: string[] }> {
	const config = options.config ?? (await loadConfig({ rootDir: options.rootDir }));
	const settings = config.providers?.["gemini-acp"];
	return {
		command: settings?.command ?? DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS.command,
		args: settings?.args ? [...settings.args] : [...DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS.args],
	};
}
