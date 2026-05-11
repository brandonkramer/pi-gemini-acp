import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { providerError } from "../prompt/provider-result.js";
import type { GeminiAcpProviderSettings, StructuredError } from "../types.js";
import {
	geminiAcpCommandNotFoundMessage,
	resolveGeminiAcpCommand,
	spawnCommandForGeminiAcpResolution,
} from "./command.js";
import {
	configFromEnv,
	loadConfig,
	saveGeminiAcpSettings,
	withDefaultGeminiAcpConfig,
} from "./settings.js";

// oxlint-disable-next-line typescript/strict-void-return -- node:util.promisify expects a Node-style callback function whose signature does not align with the rule's "returns void" expectation
const execFileAsync = promisify(execFile);
const MODEL_PATTERN = /^(?:models\/)?gemini-[a-z0-9][a-z0-9._-]{1,80}$/u;

/** User-facing Gemini model shortcut exposed by `/gemini-model` completions. */
export interface GeminiModelChoice {
	id: string;
	label: string;
	description: string;
	aliases: readonly string[];
}

export const GEMINI_MODEL_CHOICES = [
	{
		id: "gemini-3.1-pro-preview",
		label: "Gemini 3.1 Pro Preview",
		description: "Latest preview flagship for complex reasoning and high-context tasks.",
		aliases: ["pro", "3.1-pro", "3.1-pro-preview", "pro-preview"],
	},
	{
		id: "gemini-3-flash-preview",
		label: "Gemini 3 Flash Preview",
		description: "Latest Flash preview optimized for fast, cost-effective tasks.",
		aliases: ["flash", "3-flash", "3-flash-preview", "flash-preview"],
	},
	{
		id: "gemini-3.1-flash-lite-preview",
		label: "Gemini 3.1 Flash-Lite Preview",
		description: "Latest Flash-Lite preview optimized for latency-sensitive tasks.",
		aliases: ["flash-lite", "lite", "3.1-flash-lite", "3.1-flash-lite-preview"],
	},
	{
		id: "gemini-3-pro-preview",
		label: "Gemini 3 Pro Preview",
		description: "Gemini 3 Pro preview retained for provider compatibility.",
		aliases: ["3-pro", "3-pro-preview"],
	},
	{
		id: "gemini-2.5-pro",
		label: "Gemini 2.5 Pro",
		description: "Compatibility choice for Gemini 2.5 Pro reasoning tasks.",
		aliases: ["2.5-pro"],
	},
	{
		id: "gemini-2.5-flash",
		label: "Gemini 2.5 Flash",
		description: "Compatibility choice for Gemini 2.5 Flash tasks.",
		aliases: ["2.5-flash"],
	},
	{
		id: "gemini-2.5-flash-lite",
		label: "Gemini 2.5 Flash-Lite",
		description: "Compatibility choice for Gemini 2.5 Flash-Lite tasks.",
		aliases: ["2.5-flash-lite"],
	},
	{
		id: "gemini-2.0-flash",
		label: "Gemini 2.0 Flash",
		description: "Compatibility-oriented Flash model choice.",
		aliases: ["2.0-flash"],
	},
] as const satisfies readonly GeminiModelChoice[];

export interface ModelSelectionProbe {
	supported: boolean;
	checkedAt: string;
	message: string;
}

export interface ModelSelectionDeps {
	commandExists?: (command: string) => Promise<boolean>;
	readCommandHelp?: (settings: GeminiAcpProviderSettings) => Promise<string>;
	now?: () => Date;
}

export interface SetModelOptions {
	model: string;
	rootDir?: string;
}

export interface SetModelResult {
	settings?: GeminiAcpProviderSettings;
	status: GeminiAcpModelStatus;
	error?: StructuredError;
}

export interface GeminiAcpModelStatus {
	selectedModel?: string;
	modelSelectionAvailable: boolean | "unknown";
	modelSelectionCheckedAt?: string;
	message: string;
}

export async function setGeminiAcpModel(
	options: SetModelOptions,
	deps: ModelSelectionDeps = {},
): Promise<SetModelResult> {
	const model = resolveGeminiModelName(options.model);
	if (!model) {
		return {
			status: modelStatus(undefined),
			error: providerError(
				"GEMINI_ACP_INVALID_MODEL",
				"model_validation",
				`Choose one of: ${describeGeminiModelChoices()}, or pass a full Gemini model id such as models/gemini-2.5-flash.`,
			),
		};
	}

	const config = withDefaultGeminiAcpConfig(
		configFromEnv(await loadConfig({ rootDir: options.rootDir })),
	);
	const settings = config.providers?.["gemini-acp"];
	if (settings?.enabled !== true || !settings.command) {
		return {
			status: modelStatus(settings),
			error: providerError(
				"GEMINI_ACP_MISSING_CONFIG",
				"model_preflight",
				"Configure a Gemini ACP command before setting a model.",
			),
		};
	}

	const commandError = await commandResolutionError(settings.command, deps);
	if (commandError) {
		return {
			status: modelStatus(settings),
			error: providerError("GEMINI_ACP_COMMAND_NOT_FOUND", "model_preflight", commandError),
		};
	}

	const checkedAt = (deps.now?.() ?? new Date()).toISOString();
	const probe = await probeModelSelection(settings, checkedAt, deps);
	if (!probe.supported) {
		const updated = await saveGeminiAcpSettings(
			{
				modelSelectionAvailable: false,
				modelSelectionCheckedAt: checkedAt,
			},
			{ rootDir: options.rootDir },
		);
		return {
			status: modelStatus(updated.providers?.["gemini-acp"]),
			error: providerError(
				"GEMINI_ACP_MODEL_SELECTION_UNSUPPORTED",
				"model_preflight",
				probe.message,
			),
		};
	}

	const updated = await saveGeminiAcpSettings(
		{
			model,
			modelSelectionAvailable: true,
			modelSelectionCheckedAt: checkedAt,
		},
		{ rootDir: options.rootDir },
	);
	const saved = updated.providers?.["gemini-acp"];
	return { settings: saved, status: modelStatus(saved) };
}

export function modelStatus(settings: GeminiAcpProviderSettings | undefined): GeminiAcpModelStatus {
	const selectedModel = settings?.model;
	const availability = settings?.modelSelectionAvailable ?? "unknown";
	const message = selectedModel
		? `Selected model: ${selectedModel}; model selection support: ${availability}.`
		: `No Gemini model is selected; model selection support: ${availability}.`;
	return {
		selectedModel,
		modelSelectionAvailable: availability,
		modelSelectionCheckedAt: settings?.modelSelectionCheckedAt,
		message,
	};
}

export function listGeminiModelChoices(): readonly GeminiModelChoice[] {
	return GEMINI_MODEL_CHOICES;
}

export function describeGeminiModelChoices(): string {
	return GEMINI_MODEL_CHOICES.map((choice) => `${choice.id} (${choice.aliases.join("/")})`).join(
		", ",
	);
}

export function resolveGeminiModelName(model: string): string | undefined {
	const trimmed = model.trim();
	const normalized = normalizeModelName(trimmed);
	if (normalized) return normalized;
	const key = trimmed.toLowerCase();
	return GEMINI_MODEL_CHOICES.find(
		(choice) =>
			choice.id.toLowerCase() === key || (choice.aliases as readonly string[]).includes(key),
	)?.id;
}

export function normalizeModelName(model: string): string | undefined {
	const trimmed = model.trim();
	return MODEL_PATTERN.test(trimmed) ? trimmed : undefined;
}

async function probeModelSelection(
	settings: GeminiAcpProviderSettings,
	checkedAt: string,
	deps: ModelSelectionDeps,
): Promise<ModelSelectionProbe> {
	try {
		const help = await (deps.readCommandHelp ?? defaultReadCommandHelp)(settings);
		const supported = /(?:^|\s)(?:-m,\s*)?--model(?:\s|,|$)/u.test(help);
		return {
			supported,
			checkedAt,
			message: supported
				? "Gemini ACP command help exposes --model."
				: "The configured Gemini ACP command did not advertise --model support; model preference was not persisted.",
		};
	} catch (cause) {
		return {
			supported: false,
			checkedAt,
			message:
				cause instanceof Error
					? `Could not confirm model selection support: ${cause.message}`
					: "Could not confirm model selection support.",
		};
	}
}

async function defaultReadCommandHelp(settings: GeminiAcpProviderSettings): Promise<string> {
	const resolution = await resolveGeminiAcpCommand(settings.command ?? "gemini");
	const spawnCommand = spawnCommandForGeminiAcpResolution(resolution, [
		...(settings.args ?? []),
		"--help",
	]);
	const { stdout, stderr } = await execFileAsync(spawnCommand.command, spawnCommand.args, {
		timeout: 5_000,
		maxBuffer: 256_000,
		windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
	});
	return `${stdout}\n${stderr}`;
}

async function commandResolutionError(
	command: string,
	deps: ModelSelectionDeps,
): Promise<string | undefined> {
	if (deps.commandExists) {
		return (await deps.commandExists(command))
			? undefined
			: `Gemini ACP command '${command}' was not found.`;
	}
	const resolution = await resolveGeminiAcpCommand(command);
	return resolution.found ? undefined : geminiAcpCommandNotFoundMessage(resolution);
}
