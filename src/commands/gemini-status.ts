import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type GeminiAcpStatusDeps,
	type GeminiAcpStatusOptions,
	type GeminiAcpStatusReport,
	getGeminiAcpStatus,
} from "../config/status.js";
import { toolResult } from "../tools/result.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiCommand } from "./define.js";

export const geminiStatusSchema = Type.Object({});

type Params = Static<typeof geminiStatusSchema>;

export type GeminiStatusCommandOptions = GeminiAcpStatusOptions &
	GeminiAcpStatusDeps;

/** Runs the read-only Gemini ACP status/preflight report for the `/gemini-status` command. */
export async function showGeminiStatus(
	_params: Params = {},
	options: GeminiStatusCommandOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiAcpStatusReport>>> {
	const { commandExists, ...statusOptions } = options;
	const status = await getGeminiAcpStatus(statusOptions, { commandExists });
	return toolResult({
		text: commandStatusText(status),
		data: status,
		status: status.ready ? "ok" : "needs_attention",
	});
}

export const geminiStatusCommand = defineGeminiCommand({
	name: "gemini-status",
	description:
		"Show read-only Gemini ACP command/auth/capability preflight state and remediation.",
	parameters: geminiStatusSchema,
	execute: (params) => showGeminiStatus(params),
});

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
		`- configured: ${yesNo(command.configured)}`,
		`- command: ${command.command ?? "unset"}`,
		`- args: ${command.args.length > 0 ? command.args.join(" ") : "(none)"}`,
		`- executable: ${executableLabel(command.exists)}`,
		`- command kind: ${command.commandKind}${command.pathRedacted ? " (path redacted to basename)" : ""}`,
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
