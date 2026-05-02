import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type ConfigureGeminiAcpOptions,
	type ConfigureGeminiAcpResult,
	configureGeminiAcpSettings,
} from "../config/configure-acp.js";
import { errorResult, providerError, toolResult } from "../tools/result.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiCommand } from "./define.js";

export const geminiConfigureAcpSchema = Type.Object({
	command: Type.Optional(
		Type.String({
			description: "Gemini ACP executable name or path. Defaults to gemini.",
			examples: ["gemini", "/opt/homebrew/bin/gemini"],
		}),
	),
	args: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"Argument passed to the Gemini ACP command. Defaults to --acp.",
			}),
			{
				description:
					"Arguments for the Gemini ACP command. Do not include secrets; use local Gemini authentication instead.",
				examples: [["--acp"], ["--acp", "--model", "gemini-2.5-flash"]],
			},
		),
	),
});

type Params = Static<typeof geminiConfigureAcpSchema>;

/** Persists Gemini ACP command settings from slash-command parameters. */
export async function configureGeminiAcp(
	params: Params,
	options: ConfigureGeminiAcpOptions = {},
): Promise<PiToolShell<ResultEnvelope<ConfigureGeminiAcpResult | null>>> {
	const result = await configureGeminiAcpSettings(
		{ command: params.command, args: params.args },
		options,
	);
	if ("error" in result) return errorResult(result.error);

	const commandText = formatCommand(
		result.settings.command,
		result.settings.args,
	);
	if (!result.preflight.commandFound) {
		return warningResult(
			`Saved Gemini ACP command: ${commandText}. ${result.preflight.message} ${result.preflight.remediation}`,
			result,
		);
	}

	return toolResult({
		text: `Saved Gemini ACP command: ${commandText}. ${result.preflight.message}`,
		data: result,
	});
}

/** Parses raw slash-command text into command and args fields. */
export function parseConfigureAcpCommandArgs(raw: string): Params {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Params;
	const [command, ...args] = splitCommandLine(trimmed);
	return { command, args: args.length > 0 ? args : undefined };
}

export const geminiConfigureAcpCommand = defineGeminiCommand({
	name: "gemini-configure-acp",
	description:
		"Persist the local Gemini ACP command and args. Defaults to gemini --acp, runs a command-exists preflight, and refuses secret-like arguments.",
	parameters: geminiConfigureAcpSchema,
	parseArgs: parseConfigureAcpCommandArgs,
	execute: (params) => configureGeminiAcp(params),
});

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

function splitCommandLine(input: string): string[] {
	const parts: string[] = [];
	let currentPart = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			currentPart += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else currentPart += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (currentPart) {
				parts.push(currentPart);
				currentPart = "";
			}
			continue;
		}
		currentPart += char;
	}
	if (escaping) currentPart += "\\";
	if (quote) throw new Error("Unterminated quote in command arguments.");
	if (currentPart) parts.push(currentPart);
	return parts;
}

function formatCommand(
	command: string | undefined,
	args: string[] | undefined,
) {
	return [command, ...(args ?? [])]
		.filter((part): part is string => Boolean(part))
		.map(quoteArg)
		.join(" ");
}

function quoteArg(arg: string): string {
	return /\s/u.test(arg) ? JSON.stringify(arg) : arg;
}
