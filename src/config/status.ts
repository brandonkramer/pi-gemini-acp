import path from "node:path";

import { AcpProcessSession } from "../acp/session.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import { providerError } from "../prompt/provider-result.js";
import type { GeminiAcpConfig, GeminiAcpProviderSettings, StructuredError } from "../types.js";
import { defaultGeminiAcpCommandExists } from "./command.js";
import { type GeminiAcpModelStatus, modelStatus } from "./model.js";
import {
	type AcpClientCapabilities,
	describePermissionPolicy,
	permissionPolicyCapabilities,
	type ResolvedPermissionPolicy,
	resolvePermissionPolicy,
} from "./permission-policy.js";
import {
	configFromEnv,
	loadConfig,
	saveGeminiAcpSettings,
	withDefaultGeminiAcpConfig,
} from "./settings.js";

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
	rootDir?: string;
	signal?: AbortSignal;
	authProbe?: GeminiAcpAuthProbe;
	persistAuthConfirmation?: boolean;
}

export interface GeminiAcpAuthProbeResult {
	authenticated: boolean;
	message?: string;
	cause?: unknown;
}

export type GeminiAcpAuthProbe = (
	settings: GeminiAcpProviderSettings,
	signal?: AbortSignal,
) => Promise<GeminiAcpAuthProbeResult>;

export interface GeminiAcpCommandStatus {
	settingsPersisted: boolean;
	command?: string;
	args: string[];
	commandKind: "name" | "path" | "unset";
	pathRedacted: boolean;
	exists: boolean | "unknown";
}

export interface GeminiAcpImageInputStatus {
	available: boolean | "unknown";
	transport: "resource_link" | "unconfirmed";
	supportedMimeTypes: string[];
	message: string;
}

export interface GeminiAcpCapabilityStatus {
	authenticated: boolean | "unknown";
	searchGroundingAvailable: boolean | "unknown";
	searchGroundingRequired: boolean;
	fileAnalysisAvailable: boolean | "unknown";
	imageInput: GeminiAcpImageInputStatus;
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

/** Builds a read-only Gemini ACP status report from persisted/env settings plus defaults. */
export async function getGeminiAcpStatus(
	options: GeminiAcpStatusOptions = {},
	deps: GeminiAcpStatusDeps = {},
): Promise<GeminiAcpStatusReport> {
	const storedConfig = options.config ?? (await loadConfig({ rootDir: options.rootDir }));
	const loadedConfig = options.config ? storedConfig : configFromEnv(storedConfig);
	const effectiveConfig = withDefaultGeminiAcpConfig(loadedConfig);
	return await evaluateGeminiAcpStatus(
		effectiveConfig.providers?.["gemini-acp"],
		deps.commandExists ?? defaultGeminiAcpCommandExists,
		{
			settingsPersisted: hasPersistedGeminiAcpSettings(storedConfig.providers?.["gemini-acp"]),
		},
	);
}

/**
 * Evaluates effective Gemini ACP command, auth, search, model, and permission state without
 * spawning ACP.
 */
export async function evaluateGeminiAcpStatus(
	settings: GeminiAcpProviderSettings | undefined,
	commandExists: StatusCommandChecker = defaultGeminiAcpCommandExists,
	options: { settingsPersisted?: boolean } = {},
): Promise<GeminiAcpStatusReport> {
	const command = settings?.command?.trim();
	const settingsPersisted = options.settingsPersisted ?? hasPersistedGeminiAcpSettings(settings);
	const commandStatus = commandShell(settings, "unknown", settingsPersisted);
	const capabilities = capabilityShell(settings);

	if (settings?.enabled !== true || !command) {
		return statusReport(
			"missing_config",
			commandStatus,
			capabilities,
			[
				"Gemini ACP is disabled or has no effective command after applying defaults.",
				"Run `/gemini-config command gemini --acp` to save a local Gemini ACP command, or keep using local/no-key workflows over supplied documents.",
			],
			providerError(
				"GEMINI_ACP_MISSING_CONFIG",
				"provider_preflight",
				"Gemini ACP is not configured.",
			),
		);
	}

	const exists = await commandExists(command);
	const checkedCommand = commandShell(settings, exists, settingsPersisted);
	if (!exists) {
		return statusReport(
			"command_not_found",
			checkedCommand,
			capabilities,
			commandNotFoundRemediation(checkedCommand, settings),
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

	if (settings.requiresSearchGrounding !== false && settings.searchGroundingAvailable !== true) {
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

	return statusReport("ready", checkedCommand, capabilities, ["No remediation required."]);
}

/** Returns the structured Gemini ACP provider preflight error used before provider-backed discovery. */
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
		const auth = await confirmGeminiAcpAuthentication(settings, options);
		if (!auth.authenticated) {
			return providerError(
				"GEMINI_ACP_UNAUTHENTICATED",
				"provider_preflight",
				auth.message ?? "Gemini ACP is configured but authentication has not been confirmed.",
			);
		}
		if (options.persistAuthConfirmation !== false) {
			await saveGeminiAcpSettings({ authenticated: true }, { rootDir: options.rootDir });
		}
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

async function confirmGeminiAcpAuthentication(
	settings: GeminiAcpProviderSettings,
	options: GeminiAcpProviderPreflightOptions,
): Promise<GeminiAcpAuthProbeResult> {
	return await (options.authProbe ?? defaultGeminiAcpAuthProbe)(settings, options.signal);
}

async function defaultGeminiAcpAuthProbe(
	settings: GeminiAcpProviderSettings,
	signal?: AbortSignal,
): Promise<GeminiAcpAuthProbeResult> {
	let session: AcpProcessSession | undefined;
	try {
		session = await AcpProcessSession.start(buildGeminiAcpCommandSettings(settings), signal);
		await session.initialize();
		await session.newSession(process.cwd());
		return { authenticated: true };
	} catch (cause) {
		return {
			authenticated: false,
			message:
				cause instanceof Error
					? `Gemini ACP authentication could not be confirmed: ${cause.message}`
					: "Gemini ACP authentication could not be confirmed.",
			cause,
		};
	} finally {
		await session?.close();
	}
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

function hasPersistedGeminiAcpSettings(settings: GeminiAcpProviderSettings | undefined): boolean {
	return settings?.enabled === true && Boolean(settings.command?.trim());
}

function commandNotFoundRemediation(
	command: GeminiAcpCommandStatus,
	settings: GeminiAcpProviderSettings | undefined,
): string[] {
	if (!command.settingsPersisted) {
		return [
			`Gemini ACP command is not persisted; using default \`${formatCommandForMessage(settings)}\`, but it was not found on PATH. Install the Gemini CLI or run \`/gemini-config command\` to set a custom path.`,
		];
	}
	return [
		`Install the configured Gemini ACP command (${command.command ?? "unset"}) or update the command setting.`,
		"Confirm the command is on PATH, or configure the correct executable path.",
	];
}

function formatCommandForMessage(settings: GeminiAcpProviderSettings | undefined): string {
	return [settings?.command, ...(settings?.args ?? [])].filter(Boolean).join(" ");
}

function commandShell(
	settings: GeminiAcpProviderSettings | undefined,
	exists: GeminiAcpCommandStatus["exists"],
	settingsPersisted: boolean,
): GeminiAcpCommandStatus {
	const command = settings?.command?.trim();
	const commandKind = command ? (command.includes(path.sep) ? "path" : "name") : "unset";
	return {
		settingsPersisted,
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
		searchGroundingAvailable: booleanOrUnknown(settings?.searchGroundingAvailable),
		searchGroundingRequired: settings?.requiresSearchGrounding !== false,
		fileAnalysisAvailable: booleanOrUnknown(settings?.fileAnalysisAvailable),
		imageInput: imageInputStatus(settings),
		model: modelStatus(settings),
		permissionPolicy: {
			...resolvedPolicy,
			description: describePermissionPolicy(settings?.permissionPolicy),
			clientCapabilities: permissionPolicyCapabilities(settings?.permissionPolicy),
		},
	};
}

function imageInputStatus(
	settings: GeminiAcpProviderSettings | undefined,
): GeminiAcpImageInputStatus {
	const available = booleanOrUnknown(settings?.imageInputAvailable);
	return {
		available,
		transport: available === true ? "resource_link" : "unconfirmed",
		supportedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
		message:
			available === true
				? "Image paths can be sent through ACP resource links after image and embedded-context capability preflight."
				: "Gemini ACP image input support is not confirmed by the current client.",
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
