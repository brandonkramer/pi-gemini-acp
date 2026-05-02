import path from "node:path";
import type {
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
	StructuredError,
} from "../types.js";
import { defaultGeminiAcpCommandExists } from "./command.js";
import { type GeminiAcpModelStatus, modelStatus } from "./model.js";
import {
	type AcpClientCapabilities,
	describePermissionPolicy,
	permissionPolicyCapabilities,
	type ResolvedPermissionPolicy,
	resolvePermissionPolicy,
} from "./permission-policy.js";
import { configFromEnv, loadConfig } from "./settings.js";

export type GeminiAcpStatusState =
	| "missing_config"
	| "command_not_found"
	| "unauthenticated"
	| "search_unavailable"
	| "model_selection_unconfirmed"
	| "ready";

export type StatusCommandChecker = (command: string) => Promise<boolean>;

export interface GeminiAcpStatusOptions {
	rootDir?: string;
	config?: GeminiAcpConfig;
}

export interface GeminiAcpStatusDeps {
	commandExists?: StatusCommandChecker;
}

export interface GeminiAcpProviderPreflightOptions {
	commandExists?: StatusCommandChecker;
	requireSearchGrounding?: boolean;
}

export interface GeminiAcpCommandStatus {
	configured: boolean;
	command?: string;
	args: string[];
	commandKind: "name" | "path" | "unset";
	pathRedacted: boolean;
	exists: boolean | "unknown";
}

export interface GeminiAcpCapabilityStatus {
	authenticated: boolean | "unknown";
	searchGroundingAvailable: boolean | "unknown";
	searchGroundingRequired: boolean;
	model: GeminiAcpModelStatus;
	permissionPolicy: ResolvedPermissionPolicy & {
		description: string;
		clientCapabilities: AcpClientCapabilities;
	};
}

export interface GeminiAcpStatusReport {
	provider: "gemini-acp";
	ready: boolean;
	state: GeminiAcpStatusState;
	command: GeminiAcpCommandStatus;
	capabilities: GeminiAcpCapabilityStatus;
	remediation: string[];
	error?: StructuredError;
}

/**
 * Builds a read-only Gemini ACP status report from persisted settings and environment overrides.
 */
export async function getGeminiAcpStatus(
	options: GeminiAcpStatusOptions = {},
	deps: GeminiAcpStatusDeps = {},
): Promise<GeminiAcpStatusReport> {
	const loadedConfig =
		options.config ??
		configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	return evaluateGeminiAcpStatus(
		loadedConfig.providers?.["gemini-acp"],
		deps.commandExists ?? defaultGeminiAcpCommandExists,
	);
}

/**
 * Evaluates configured Gemini ACP command, auth, search, model, and permission state without spawning ACP.
 */
export async function evaluateGeminiAcpStatus(
	settings: GeminiAcpProviderSettings | undefined,
	commandExists: StatusCommandChecker = defaultGeminiAcpCommandExists,
): Promise<GeminiAcpStatusReport> {
	const command = settings?.command?.trim();
	const commandStatus = commandShell(settings, "unknown");
	const capabilities = capabilityShell(settings);

	if (settings?.enabled !== true || !command) {
		return statusReport(
			"missing_config",
			commandStatus,
			capabilities,
			[
				"Configure a local Gemini ACP command such as `gemini --acp` before using Gemini-backed discovery.",
				"This status reports explicit persisted/env settings and does not apply the gemini_search compatibility default; search may still try `gemini --acp` until settings are configured or disabled.",
				"Local/no-key workflows over supplied documents remain available without Gemini ACP.",
			],
			providerError(
				"GEMINI_ACP_MISSING_CONFIG",
				"provider_preflight",
				"Gemini ACP is not configured.",
			),
		);
	}

	const exists = await commandExists(command);
	const checkedCommand = commandShell(settings, exists);
	if (!exists) {
		return statusReport(
			"command_not_found",
			checkedCommand,
			capabilities,
			[
				`Install the configured Gemini ACP command (${checkedCommand.command ?? "unset"}) or update the command setting.`,
				"Confirm the command is on PATH, or configure the correct executable path.",
			],
			providerError(
				"GEMINI_ACP_COMMAND_NOT_FOUND",
				"provider_preflight",
				`Gemini ACP command '${checkedCommand.command ?? command}' was not found.`,
			),
		);
	}

	if (settings.authenticated !== true) {
		return statusReport(
			"unauthenticated",
			checkedCommand,
			capabilities,
			[
				"Run the configured Gemini CLI/ACP login flow locally, then mark authentication as confirmed in Gemini ACP settings.",
				"This package does not require or store Gemini API keys for local supplied-document workflows.",
			],
			providerError(
				"GEMINI_ACP_UNAUTHENTICATED",
				"provider_preflight",
				"Gemini ACP is configured but authentication has not been confirmed.",
			),
		);
	}

	if (
		settings.requiresSearchGrounding !== false &&
		settings.searchGroundingAvailable !== true
	) {
		return statusReport(
			"search_unavailable",
			checkedCommand,
			capabilities,
			[
				"Confirm the local Gemini ACP runtime exposes grounded web/search capability before using gemini_search or global gemini_research.",
				"Use supplied documents or sources for local/no-key workflows while search grounding is unavailable.",
			],
			providerError(
				"GEMINI_ACP_SEARCH_UNAVAILABLE",
				"provider_preflight",
				"Gemini ACP is not confirmed to expose web/search grounding.",
			),
		);
	}

	if (settings.model && settings.modelSelectionAvailable !== true) {
		return statusReport(
			"model_selection_unconfirmed",
			checkedCommand,
			capabilities,
			[
				"Run /gemini-model after configuring the ACP command to confirm model-selection support.",
				"Remove the configured model if this ACP runtime cannot pass model preferences safely.",
			],
			providerError(
				"GEMINI_ACP_MODEL_SELECTION_UNCONFIRMED",
				"provider_preflight",
				"A Gemini model is configured, but this ACP runtime has not confirmed --model support.",
			),
		);
	}

	return statusReport("ready", checkedCommand, capabilities, [
		"No remediation required.",
	]);
}

/**
 * Returns the structured Gemini ACP provider preflight error used before provider-backed discovery.
 */
export async function preflightGeminiAcpProvider(
	settings: GeminiAcpProviderSettings | undefined,
	options: GeminiAcpProviderPreflightOptions = {},
): Promise<StructuredError | undefined> {
	if (settings?.enabled !== true || !settings.command) {
		return providerError(
			"GEMINI_ACP_MISSING_CONFIG",
			"provider_preflight",
			"Gemini ACP is not configured.",
		);
	}
	const commandExists = options.commandExists ?? defaultGeminiAcpCommandExists;
	if (!(await commandExists(settings.command))) {
		return providerError(
			"GEMINI_ACP_COMMAND_NOT_FOUND",
			"provider_preflight",
			`Gemini ACP command '${settings.command}' was not found.`,
		);
	}
	if (settings.authenticated !== true) {
		return providerError(
			"GEMINI_ACP_UNAUTHENTICATED",
			"provider_preflight",
			"Gemini ACP is configured but authentication has not been confirmed.",
		);
	}
	if (
		options.requireSearchGrounding === true &&
		settings.requiresSearchGrounding !== false &&
		settings.searchGroundingAvailable !== true
	) {
		return providerError(
			"GEMINI_ACP_SEARCH_UNAVAILABLE",
			"provider_preflight",
			"Gemini ACP is not confirmed to expose web/search grounding.",
		);
	}
	if (settings.model && settings.modelSelectionAvailable !== true) {
		return providerError(
			"GEMINI_ACP_MODEL_SELECTION_UNCONFIRMED",
			"provider_preflight",
			"A Gemini model is configured, but this ACP runtime has not confirmed --model support. Run /gemini-model after configuring the ACP command.",
		);
	}
	return undefined;
}

function statusReport(
	state: GeminiAcpStatusState,
	command: GeminiAcpCommandStatus,
	capabilities: GeminiAcpCapabilityStatus,
	remediation: string[],
	error?: StructuredError,
): GeminiAcpStatusReport {
	return {
		provider: "gemini-acp",
		ready: state === "ready",
		state,
		command,
		capabilities,
		remediation,
		error,
	};
}

function commandShell(
	settings: GeminiAcpProviderSettings | undefined,
	exists: GeminiAcpCommandStatus["exists"],
): GeminiAcpCommandStatus {
	const command = settings?.command?.trim();
	const commandKind = command
		? command.includes(path.sep)
			? "path"
			: "name"
		: "unset";
	return {
		configured: settings?.enabled === true && Boolean(command),
		command: command ? safeCommandName(command) : undefined,
		args: sanitizeArgs(settings?.args),
		commandKind,
		pathRedacted: commandKind === "path",
		exists,
	};
}

function capabilityShell(
	settings: GeminiAcpProviderSettings | undefined,
): GeminiAcpCapabilityStatus {
	const resolvedPolicy = resolvePermissionPolicy(settings?.permissionPolicy);
	return {
		authenticated: booleanOrUnknown(settings?.authenticated),
		searchGroundingAvailable: booleanOrUnknown(
			settings?.searchGroundingAvailable,
		),
		searchGroundingRequired: settings?.requiresSearchGrounding !== false,
		model: modelStatus(settings),
		permissionPolicy: {
			...resolvedPolicy,
			description: describePermissionPolicy(settings?.permissionPolicy),
			clientCapabilities: permissionPolicyCapabilities(
				settings?.permissionPolicy,
			),
		},
	};
}

function booleanOrUnknown(value: boolean | undefined): boolean | "unknown" {
	return typeof value === "boolean" ? value : "unknown";
}

function safeCommandName(command: string): string {
	return command.includes(path.sep) ? path.basename(command) : command;
}

function sanitizeArgs(args: string[] | undefined): string[] {
	let redactNext = false;
	return (args ?? []).map((arg) => {
		if (redactNext) {
			redactNext = false;
			return "<redacted>";
		}
		const secretFlag = arg.match(
			/^(--?(?:api[-_]?key|token|secret|password|credential|auth))(?:=(.*))?$/iu,
		);
		if (!secretFlag) return arg;
		if (secretFlag[2] === undefined) {
			redactNext = true;
			return secretFlag[1] ?? "<redacted>";
		}
		return `${secretFlag[1]}=<redacted>`;
	});
}

function providerError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}
