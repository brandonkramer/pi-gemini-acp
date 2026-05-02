import path from "node:path";
import { type Static, Type } from "@mariozechner/pi-ai";
import { configFromEnv, loadConfig } from "../config/settings.js";
import { toolResult } from "../tools/result.js";
import type { GeminiAcpConfig, GeminiAcpProviderSettings } from "../types.js";
import { defineGeminiCommand } from "./define.js";

const STATUS_REMEDIATIONS = [
	{
		code: "GEMINI_ACP_MISSING_CONFIG",
		meaning: "No local Gemini ACP command is configured.",
		remediation:
			"Configure a local ACP command such as `gemini --acp`, then run `/gemini-status` again.",
	},
	{
		code: "GEMINI_ACP_COMMAND_NOT_FOUND",
		meaning: "The configured command could not be found on this machine.",
		remediation:
			"Install the Gemini CLI/provider command or update the configured command path.",
	},
	{
		code: "GEMINI_ACP_UNAUTHENTICATED",
		meaning:
			"The command exists, but Gemini ACP authentication is not confirmed.",
		remediation:
			"Run the provider's local login/auth flow in your terminal, then re-check `/gemini-status`.",
	},
	{
		code: "GEMINI_ACP_SEARCH_UNAVAILABLE",
		meaning:
			"Authentication may be present, but search grounding is unconfirmed.",
		remediation:
			"Confirm the selected account/model supports grounded search before global discovery.",
	},
] as const;

export const geminiLoginHelpSchema = Type.Object({
	statusCode: Type.Optional(
		Type.String({
			description:
				"Optional gemini_status error code to focus remediation guidance.",
		}),
	),
});

type Params = Static<typeof geminiLoginHelpSchema>;

export interface GeminiLoginHelpOptions {
	rootDir?: string;
	config?: GeminiAcpConfig;
}

export interface GeminiLoginHelpData {
	configured: boolean;
	configuredCommand?: string;
	statusCode?: string;
	remediations: typeof STATUS_REMEDIATIONS;
	mutatesConfig: false;
	runsAuthFlow: false;
}

/** Builds read-only Gemini ACP login remediation text and structured details. */
export function buildGeminiLoginHelp(
	params: Params = {},
	config: GeminiAcpConfig = {},
): { text: string; data: GeminiLoginHelpData } {
	const settings = config.providers?.["gemini-acp"];
	const configuredCommand = renderConfiguredCommand(settings);
	const focused = STATUS_REMEDIATIONS.find(
		(entry) => entry.code === params.statusCode,
	);
	const lines = [
		"Gemini ACP login help",
		"",
		configuredCommand
			? `Configured ACP command: ${configuredCommand}`
			: "Configured ACP command: not configured yet",
		"",
		"This command is read-only. It does not mutate config, run login flows, print tokens, or inspect provider-private credential files.",
		"Gemini authentication is managed by your local Gemini provider/CLI, not by pi-gemini-acp.",
		"Gemini-backed global discovery should run only after `/gemini-status` confirms command, auth, and search-grounding readiness.",
		"",
		focused
			? `Focused remediation for ${focused.code}:`
			: "Status remediation:",
		...(focused
			? [formatRemediation(focused)]
			: STATUS_REMEDIATIONS.map(formatRemediation)),
		"",
		"Safe next steps:",
		"1. Verify the configured command is installed and available in your terminal.",
		"2. Use the provider's documented local login/auth command outside Pi.",
		"3. Re-run `/gemini-status`; if search grounding is still unconfirmed, check provider/model support.",
	];
	return {
		text: lines.join("\n"),
		data: {
			configured: configuredCommand !== undefined,
			configuredCommand,
			statusCode: params.statusCode,
			remediations: STATUS_REMEDIATIONS,
			mutatesConfig: false,
			runsAuthFlow: false,
		},
	};
}

/** Loads effective config and returns Gemini ACP login help without side effects. */
export async function runGeminiLoginHelp(
	params: Params = {},
	options: GeminiLoginHelpOptions = {},
) {
	const config = options.config ?? configFromEnv(await loadConfig(options));
	const help = buildGeminiLoginHelp(params, config);
	return toolResult({ text: help.text, data: help.data });
}

export const geminiLoginHelpCommand = defineGeminiCommand({
	name: "gemini-login-help",
	description:
		"Explain local Gemini ACP login/auth remediation without mutating config or running auth flows.",
	parameters: geminiLoginHelpSchema,
	execute: (params) => runGeminiLoginHelp(params),
});

function formatRemediation(
	entry: (typeof STATUS_REMEDIATIONS)[number],
): string {
	return `- ${entry.code}: ${entry.meaning} ${entry.remediation}`;
}

function renderConfiguredCommand(
	settings: GeminiAcpProviderSettings | undefined,
): string | undefined {
	if (settings?.enabled !== true || !settings.command) return undefined;
	return [safeCommandName(settings.command), ...redactArgs(settings.args ?? [])]
		.filter(Boolean)
		.join(" ");
}

function safeCommandName(command: string): string {
	return command.includes(path.sep) ? path.basename(command) : command;
}

function redactArgs(args: string[]): string[] {
	let redactNext = false;
	return args.map((arg) => {
		if (redactNext) {
			redactNext = false;
			return "[redacted]";
		}
		if (!isSensitiveArg(arg)) return arg;
		if (!arg.includes("=")) redactNext = true;
		return arg.includes("=") ? `${arg.split("=")[0]}=[redacted]` : arg;
	});
}

function isSensitiveArg(arg: string): boolean {
	return /(?:token|api[-_]?key|secret|password|credential|auth)/iu.test(arg);
}
