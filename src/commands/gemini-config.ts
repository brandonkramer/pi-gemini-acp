import { type Static, Type } from "@mariozechner/pi-ai";
import type { ConfigureGeminiAcpOptions } from "../config/configure-acp.js";
import {
	type GeminiAcpCommandStatus,
	type GeminiAcpStatusDeps,
	type GeminiAcpStatusOptions,
	type GeminiAcpStatusReport,
	getGeminiAcpStatus,
} from "../config/status.js";
import { toolResult } from "../tools/result.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiCommand, type PiCommandContext } from "./define.js";
import {
	type GeminiConfigPermissionsOptions,
	type GeminiConfigPermissionsResult,
	runGeminiConfigPermissions,
	showGeminiConfigPermissionsPicker,
} from "./gemini-config-permissions.js";
import type {
	GeminiConfigPersistOptions,
	GeminiConfigPersistResult,
} from "./gemini-config-persist.js";
import {
	runGeminiConfigPersist,
	showGeminiConfigPersistPicker,
} from "./gemini-config-persist.js";
import { hasInteractiveUi, type InteractiveCommandContext } from "./picker.js";

export const geminiConfigSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status", {
				description:
					"Show read-only Gemini ACP command/auth/capability preflight state.",
			}),
			Type.Literal("persist", {
				description:
					"Persist Gemini ACP command/args to ~/.pi/gemini-acp/settings.json.",
			}),
			Type.Literal("permissions", {
				description:
					"Show and optionally modify Gemini ACP capability settings with descriptions.",
			}),
		],
		{
			description:
				"Choose whether to inspect status, persist command settings, or manage Gemini ACP permissions.",
		},
	),
	command: Type.Optional(
		Type.String({
			description:
				"Gemini ACP executable name or path for action=persist. Defaults to gemini.",
			examples: ["gemini", "/opt/homebrew/bin/gemini"],
		}),
	),
	args: Type.Optional(
		Type.Array(
			Type.String({
				description:
					"Argument passed to the Gemini ACP command for action=persist. Defaults to --acp.",
			}),
			{
				description:
					"Arguments for the Gemini ACP command. Do not include secrets; use local Gemini authentication instead.",
				examples: [["--acp"], ["--acp", "--model", "gemini-2.5-flash"]],
			},
		),
	),
	capability: Type.Optional(
		Type.Union(
			[
				Type.Literal("filesystemRead"),
				Type.Literal("filesystemWrite"),
				Type.Literal("terminal"),
			],
			{
				description:
					"Capability to toggle for action=permissions. Omit to show current settings.",
			},
		),
	),
	enabled: Type.Optional(
		Type.Boolean({
			description:
				"Desired capability state for action=permissions. Omit to toggle the current value.",
		}),
	),
	confirmRisk: Type.Optional(
		Type.Boolean({
			description:
				"Must be true when enabling filesystemWrite or terminal permissions.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description:
				"Optional reason to store with permission changes for later status output.",
		}),
	),
});

type Params = Static<typeof geminiConfigSchema>;
type CommandParams = Omit<Params, "action"> & { action?: Params["action"] };

export type GeminiConfigCommandOptions = ConfigureGeminiAcpOptions &
	GeminiAcpStatusOptions &
	GeminiAcpStatusDeps &
	GeminiConfigPermissionsOptions &
	GeminiConfigPersistOptions;

/** Runs the selected `/gemini-config` action. */
export async function runGeminiConfig(
	params: CommandParams,
	options: GeminiConfigCommandOptions = {},
): Promise<
	PiToolShell<
		ResultEnvelope<
			| GeminiAcpStatusReport
			| GeminiConfigPersistResult
			| GeminiConfigPermissionsResult
			| null
		>
	>
> {
	if (!params.action) {
		throw new Error("Expected action 'status', 'persist', or 'permissions'.");
	}
	if (params.action === "persist")
		return runGeminiConfigPersist(params, options);
	if (params.action === "permissions") {
		return runGeminiConfigPermissions(
			{
				capability: params.capability,
				enabled: params.enabled,
				confirmRisk: params.confirmRisk,
				reason: params.reason,
			},
			options,
		);
	}
	return showGeminiConfigStatus(options);
}

export async function runGeminiConfigCommand(
	params: CommandParams,
	ctx?: PiCommandContext,
	options: GeminiConfigCommandOptions = {},
) {
	if (!params.action && hasInteractiveUi(ctx)) {
		return showGeminiConfigActionPicker(ctx, options);
	}
	if (
		params.action === "permissions" &&
		!params.capability &&
		hasInteractiveUi(ctx)
	) {
		return showGeminiConfigPermissionsPicker(ctx, options);
	}
	if (
		params.action === "persist" &&
		!params.command &&
		!params.args &&
		hasInteractiveUi(ctx)
	) {
		return showGeminiConfigPersistPicker(ctx, options);
	}
	return runGeminiConfig(params, options);
}

/** Parses raw slash-command text into `/gemini-config` action parameters. */
export function parseGeminiConfigCommandArgs(raw: string): Params {
	const trimmed = raw.trim();
	if (!trimmed) return {} as Params;
	if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Params;

	const [action, ...rest] = splitCommandLine(trimmed);
	if (action !== "status" && action !== "persist" && action !== "permissions") {
		throw new Error("Expected action 'status', 'persist', or 'permissions'.");
	}
	if (action === "status") {
		if (rest.length > 0) {
			throw new Error("Action 'status' does not accept command arguments.");
		}
		return { action };
	}
	if (action === "permissions") return parsePermissionsArgs(rest);

	const [command, ...args] = rest;
	return {
		action,
		command,
		args: args.length > 0 ? args : undefined,
	};
}

function parsePermissionsArgs(parts: string[]): Params {
	if (parts.length === 0) return { action: "permissions" };
	const [rawCapability, ...rest] = parts;
	if (!isPermissionCapability(rawCapability)) {
		throw new Error(
			"Expected permission capability 'filesystemRead', 'filesystemWrite', or 'terminal'.",
		);
	}
	let enabled: boolean | undefined;
	let confirmRisk: boolean | undefined;
	const reasonParts: string[] = [];
	for (const token of rest) {
		const booleanToken = parseBooleanToken(token);
		if (enabled === undefined && booleanToken !== undefined) {
			enabled = booleanToken;
			continue;
		}
		if (token.startsWith("confirmRisk=")) {
			confirmRisk = parseBooleanToken(token.slice("confirmRisk=".length));
			continue;
		}
		if (token.startsWith("reason=")) {
			reasonParts.push(token.slice("reason=".length));
			continue;
		}
		reasonParts.push(token);
	}
	return {
		action: "permissions",
		capability: rawCapability,
		enabled,
		confirmRisk,
		reason: reasonParts.length > 0 ? reasonParts.join(" ") : undefined,
	};
}

function isPermissionCapability(
	value: string | undefined,
): value is NonNullable<Params["capability"]> {
	return (
		value === "filesystemRead" ||
		value === "filesystemWrite" ||
		value === "terminal"
	);
}

function parseBooleanToken(value: string): boolean | undefined {
	switch (value.toLowerCase()) {
		case "true":
		case "on":
		case "enable":
		case "enabled":
			return true;
		case "false":
		case "off":
		case "disable":
		case "disabled":
			return false;
		default:
			return undefined;
	}
}

export const geminiConfigCommand = defineGeminiCommand({
	name: "gemini-config",
	description:
		"Inspect Gemini ACP status, persist the local command/args, or manage ACP capability permissions with settings-style descriptions.",
	parameters: geminiConfigSchema,
	parseArgs: parseGeminiConfigCommandArgs,
	execute: (params, ctx) => runGeminiConfigCommand(params, ctx),
});

async function showGeminiConfigActionPicker(
	ctx: InteractiveCommandContext,
	options: GeminiConfigCommandOptions,
) {
	const picked = await ctx.ui.select(
		"Gemini config",
		["Status", "Persist", "Permissions"],
		{ signal: ctx.signal },
	);
	if (!picked) {
		return toolResult({ text: "Cancelled.", data: { cancelled: true } });
	}
	if (picked === "Permissions") {
		return showGeminiConfigPermissionsPicker(ctx, options);
	}
	if (picked === "Persist") return showGeminiConfigPersistPicker(ctx, options);
	return runGeminiConfig({ action: "status" }, options);
}
async function showGeminiConfigStatus(
	options: GeminiConfigCommandOptions,
): Promise<PiToolShell<ResultEnvelope<GeminiAcpStatusReport>>> {
	const { commandExists, ...statusOptions } = options;
	const status = await getGeminiAcpStatus(statusOptions, { commandExists });
	return toolResult({
		text: commandStatusText(status),
		data: status,
		status: status.ready ? "ok" : "needs_attention",
	});
}


function commandStatusText(status: GeminiAcpStatusReport): string {
	const command = status.command;
	const capabilities = status.capabilities;
	const clientCapabilities = capabilities.permissionPolicy.clientCapabilities;
	return [
		status.ready
			? "Gemini ACP is ready for Gemini-backed search/research."
			: `Gemini ACP needs attention: ${status.error?.message ?? status.state}.`,
		"",
		"Command:",
		`- settingsPersisted: ${yesNo(command.settingsPersisted)}`,
		`- command: ${formatCommandDisplay(command)}`,
		`- args: ${formatArgsDisplay(command)}`,
		`- executable: ${executableLabel(command.exists)}`,
		`- command kind: ${formatCommandKindDisplay(command)}`,
		"",
		"Capabilities:",
		`- auth: ${boolLabel(capabilities.authenticated, "confirmed", "not confirmed")}`,
		`- search grounding: ${boolLabel(capabilities.searchGroundingAvailable, "available", "not confirmed")} (required: ${yesNo(capabilities.searchGroundingRequired)})`,
		`- file analysis: ${boolLabel(capabilities.fileAnalysisAvailable, "available", "not confirmed")} (tool returns unsupported until ACP file/document transport is implemented)`,
		`- image input: ${boolLabel(capabilities.imageInput.available, "available", "not confirmed")} (transport: ${capabilities.imageInput.transport})`,
		`- model: ${capabilities.model.message}`,
		`- permission policy: ${capabilities.permissionPolicy.description}`,
		"",
		"Future ACP capability flags:",
		`- auth terminal: ${enabledDisabled(clientCapabilities.auth.terminal)}`,
		`- filesystem read: ${enabledDisabled(clientCapabilities.fs.readTextFile)}`,
		`- filesystem write: ${enabledDisabled(clientCapabilities.fs.writeTextFile)}`,
		`- terminal: ${enabledDisabled(clientCapabilities.terminal)}`,
		"",
		"Remediation:",
		...status.remediation.map((item) => `- ${item}`),
	].join("\n");
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


function formatCommandDisplay(status: GeminiAcpCommandStatus): string {
	const suffix = defaultSuffix(status);
	return status.command ? `${status.command}${suffix}` : `unset${suffix}`;
}

function formatArgsDisplay(status: GeminiAcpCommandStatus): string {
	const suffix = defaultSuffix(status);
	return status.args.length > 0
		? `${status.args.join(" ")}${suffix}`
		: `(none)${suffix}`;
}

function formatCommandKindDisplay(status: GeminiAcpCommandStatus): string {
	const suffix = defaultSuffix(status);
	const redacted = status.pathRedacted ? " (path redacted to basename)" : "";
	return `${status.commandKind}${suffix}${redacted}`;
}

function defaultSuffix(status: GeminiAcpCommandStatus): string {
	return status.settingsPersisted ? "" : " (default)";
}

function executableLabel(exists: boolean | "unknown"): string {
	if (exists === "unknown") return "unknown";
	return exists ? "found" : "not found";
}

function boolLabel(
	value: boolean | "unknown",
	trueLabel: string,
	falseLabel: string,
): string {
	if (value === "unknown") return "unknown";
	return value ? trueLabel : falseLabel;
}

function enabledDisabled(value: boolean): string {
	return value ? "enabled" : "disabled";
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}
