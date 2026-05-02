import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GeminiAcpProviderSettings, StructuredError } from "../types.js";
import {
	configFromEnv,
	loadConfig,
	saveGeminiAcpSettings,
} from "./settings.js";

const execFileAsync = promisify(execFile);
const MODEL_PATTERN = /^(?:models\/)?gemini-[a-z0-9][a-z0-9._-]{1,80}$/u;

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
	const model = normalizeModelName(options.model);
	if (!model) {
		return {
			status: modelStatus(undefined),
			error: providerError(
				"GEMINI_ACP_INVALID_MODEL",
				"model_validation",
				"Model must look like a Gemini model id, for example gemini-2.5-pro or models/gemini-2.5-flash.",
			),
		};
	}

	const config = configFromEnv(await loadConfig({ rootDir: options.rootDir }));
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

	const commandExists = deps.commandExists ?? defaultCommandExists;
	if (!(await commandExists(settings.command))) {
		return {
			status: modelStatus(settings),
			error: providerError(
				"GEMINI_ACP_COMMAND_NOT_FOUND",
				"model_preflight",
				`Gemini ACP command '${settings.command}' was not found.`,
			),
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

export function modelStatus(
	settings: GeminiAcpProviderSettings | undefined,
): GeminiAcpModelStatus {
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
		const help = await (deps.readCommandHelp ?? defaultReadCommandHelp)(
			settings,
		);
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

async function defaultReadCommandHelp(
	settings: GeminiAcpProviderSettings,
): Promise<string> {
	const { stdout, stderr } = await execFileAsync(
		settings.command ?? "gemini",
		[...(settings.args ?? []), "--help"],
		{ timeout: 5_000, maxBuffer: 256_000 },
	);
	return `${stdout}\n${stderr}`;
}

async function defaultCommandExists(command: string): Promise<boolean> {
	if (command.includes(path.sep)) {
		try {
			await access(command);
			return true;
		} catch {
			return false;
		}
	}
	for (const dir of (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)) {
		try {
			await access(path.join(dir, command));
			return true;
		} catch {
			/* continue */
		}
	}
	return false;
}

function providerError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}
