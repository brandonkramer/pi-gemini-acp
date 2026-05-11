import {
	type ConfigureGeminiAcpOptions,
	type ConfigureGeminiAcpResult,
	configureGeminiAcpSettings,
} from "../config/configure-acp.ts";
import { DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS, loadConfig } from "../config/settings.ts";
import { providerError } from "../prompt/provider-result.ts";
import { errorResult, toolResult } from "../tools/result.ts";
import type { GeminiAcpConfig, PiToolShell, ResultEnvelope } from "../types.ts";
import type { PiCommandContext } from "./define.ts";
import { hasInteractiveUi, type InteractiveCommandContext } from "./picker.ts";

export interface GeminiConfigAcpCommandParams {
	executable?: string;
	args?: string[];
}

export interface GeminiConfigAcpCommandOptions extends ConfigureGeminiAcpOptions {
	config?: GeminiAcpConfig;
}

export type GeminiConfigAcpCommandResult = ConfigureGeminiAcpResult | { cancelled: true } | null;

/** Shows a settings-style picker for staging Gemini ACP command/args before saving. */
export async function showAcpCommandPicker(
	ctx: PiCommandContext,
	options: GeminiConfigAcpCommandOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigAcpCommandResult>>> {
	if (!hasInteractiveUi(ctx)) return await runAcpCommandConfig({}, options);
	return await showInteractiveAcpCommandPicker(ctx, options);
}

/** Saves Gemini ACP command settings and reports command preflight status. */
export async function runAcpCommandConfig(
	params: GeminiConfigAcpCommandParams,
	options: GeminiConfigAcpCommandOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigAcpCommandResult>>> {
	const result = await configureGeminiAcpSettings(
		{ command: params.executable, args: params.args },
		options,
	);
	if ("error" in result) return errorResult(result.error);

	const commandText = formatCommand(result.settings.command, result.settings.args);
	if (!result.preflight.commandFound) {
		return warningResult(
			`Saved Gemini ACP command: ${commandText}. ${result.preflight.message} ${result.preflight.remediation ?? ""}`,
			result,
		);
	}

	return toolResult({
		text: `Saved Gemini ACP command: ${commandText}. ${result.preflight.message}`,
		data: result,
	});
}

async function showInteractiveAcpCommandPicker(
	ctx: InteractiveCommandContext,
	options: GeminiConfigAcpCommandOptions,
): Promise<PiToolShell<ResultEnvelope<GeminiConfigAcpCommandResult>>> {
	const current = await loadCurrentAcpCommandSettings(options);
	let localCommand = current.command;
	let localArgs = [...current.args];

	while (true) {
		const picked = await ctx.ui.select(
			"ACP command settings",
			settingsChoices(localCommand, localArgs),
			{ signal: ctx.signal },
		);
		if (!picked || picked === "Cancel") return cancelledResult();
		if (picked.startsWith("Command:")) {
			const command = await ctx.ui.input("Edit command", localCommand, {
				signal: ctx.signal,
			});
			if (command !== undefined) localCommand = command.trim();
			continue;
		}
		if (picked.startsWith("Args:")) {
			localArgs = await editArgs(ctx, localArgs);
			continue;
		}
		if (picked === "Save and apply") {
			return await runAcpCommandConfig({ executable: localCommand, args: localArgs }, options);
		}
	}
}

async function editArgs(ctx: InteractiveCommandContext, initialArgs: string[]): Promise<string[]> {
	const localArgs = [...initialArgs];
	while (true) {
		const choices = argsChoices(localArgs);
		const picked = await ctx.ui.select("Edit Gemini ACP args", choices, {
			signal: ctx.signal,
		});
		if (!picked || picked === "Done") return localArgs;
		if (picked === "Add new arg") {
			const arg = await ctx.ui.input("New argument", "", {
				signal: ctx.signal,
			});
			const normalized = arg?.trim();
			if (normalized) localArgs.push(normalized);
			continue;
		}
		const index = choices.indexOf(picked);
		if (index >= 0 && index < localArgs.length) localArgs.splice(index, 1);
	}
}

async function loadCurrentAcpCommandSettings(
	options: GeminiConfigAcpCommandOptions,
): Promise<{ command: string; args: string[] }> {
	const config = options.config ?? (await loadConfig({ rootDir: options.rootDir }));
	const settings = config.providers?.["gemini-acp"];
	return {
		command: settings?.command ?? DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS.command,
		args: settings?.args ? [...settings.args] : [...DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS.args],
	};
}

function settingsChoices(command: string, args: string[]): string[] {
	return [
		`Command: ${command || "(empty)"}`,
		`Args: ${formatArgsRow(args)}`,
		"Save and apply",
		"Cancel",
	];
}

function argsChoices(args: string[]): string[] {
	return [...args.map((arg) => `Remove ${arg}`), "Add new arg", "Done"];
}

function cancelledResult(): PiToolShell<ResultEnvelope<{ cancelled: true }>> {
	return toolResult({ text: "Cancelled.", data: { cancelled: true } });
}

function warningResult(
	text: string,
	data: ConfigureGeminiAcpResult,
): PiToolShell<ResultEnvelope<ConfigureGeminiAcpResult>> {
	return {
		content: [{ type: "text", text }],
		details: {
			status: "warning",
			timing: { startedAt: new Date().toISOString() },
			error: providerError(
				"GEMINI_ACP_COMMAND_NOT_FOUND",
				"configure_acp_preflight",
				data.preflight.message,
			),
			data,
		},
	};
}

function formatArgsRow(args: string[]): string {
	return args.length > 0 ? args.join(" ") : "(none)";
}

function formatCommand(command: string | undefined, args: string[] | undefined): string {
	return (
		[command, ...(args ?? [])]
			// oxlint-disable-next-line unicorn/prefer-native-coercion-functions -- type guard preserves string[] for downstream .map(quoteArg)
			.filter((part): part is string => Boolean(part))
			// oxlint-disable-next-line unicorn/no-array-callback-reference -- quoteArg takes one arg
			.map(quoteArg)
			.join(" ")
	);
}

function quoteArg(arg: string): string {
	return /\s/u.test(arg) ? JSON.stringify(arg) : arg;
}
