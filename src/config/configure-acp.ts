import type { StorageOptions } from "../storage/paths.js";
import type { GeminiAcpProviderSettings, StructuredError } from "../types.js";
import {
	type CommandExists,
	defaultGeminiAcpCommandExists,
} from "./command.js";
import {
	DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS,
	saveGeminiAcpSettings,
} from "./settings.js";

const SECRET_FLAG_PATTERN =
	/^--?(?:api[-_]?key|key|token|secret|password)(?:=|$)/iu;
const SECRET_ENV_PATTERN =
	/^[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=/iu;

/** User-provided command settings accepted by `/gemini-configure-acp`. */
export interface ConfigureGeminiAcpInput {
	command?: string;
	args?: readonly string[];
}

/** Lightweight post-save command preflight reported by `/gemini-configure-acp`. */
export interface GeminiAcpCommandPreflight {
	commandFound: boolean;
	checkedAt: string;
	message: string;
	remediation?: string;
}

/** Dependencies and storage options used while persisting ACP command settings. */
export interface ConfigureGeminiAcpOptions extends StorageOptions {
	commandExists?: CommandExists;
	now?: () => Date;
}

/** Result persisted and reported by `/gemini-configure-acp`. */
export interface ConfigureGeminiAcpResult {
	settings: GeminiAcpProviderSettings;
	preflight: GeminiAcpCommandPreflight;
}

/**
 * Persists the local Gemini ACP command/args and then verifies that the command exists.
 *
 * The command is intentionally limited to local executable configuration; secrets such
 * as API keys or tokens are refused because Gemini ACP should use the user's existing
 * local authentication rather than persisted credentials in Pi config files.
 */
export async function configureGeminiAcpSettings(
	input: ConfigureGeminiAcpInput,
	options: ConfigureGeminiAcpOptions = {},
): Promise<ConfigureGeminiAcpResult | { error: StructuredError }> {
	const normalized = normalizeGeminiAcpSettings(input);
	if ("error" in normalized) return normalized;

	const config = await saveGeminiAcpSettings(normalized.settings, {
		rootDir: options.rootDir,
	});
	const settings = config.providers?.["gemini-acp"] ?? normalized.settings;
	const checkedAt = (options.now?.() ?? new Date()).toISOString();
	const commandFound = await runCommandExistsPreflight(
		settings.command ?? normalized.settings.command,
		options.commandExists ?? defaultGeminiAcpCommandExists,
	);
	return {
		settings,
		preflight: commandFound
			? {
					commandFound,
					checkedAt,
					message: `Command '${settings.command}' is executable.`,
				}
			: {
					commandFound,
					checkedAt,
					message: `Command '${settings.command}' was saved but was not found or is not executable.`,
					remediation:
						"Install and authenticate the Gemini CLI, ensure it is on PATH, or rerun /gemini-configure-acp with an executable path.",
				},
	};
}

/** Normalizes and validates command/args before any persisted settings write. */
export function normalizeGeminiAcpSettings(
	input: ConfigureGeminiAcpInput,
): { settings: GeminiAcpProviderSettings } | { error: StructuredError } {
	const command = (
		input.command ?? DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS.command
	)?.trim();
	if (!command || /\s/u.test(command)) {
		return {
			error: providerError(
				"GEMINI_ACP_INVALID_COMMAND",
				"configure_acp",
				"Pass the Gemini ACP executable as command and put flags in args, for example command 'gemini' with args ['--acp'].",
			),
		};
	}

	const args = input.args
		? input.args.map((arg) => arg.trim()).filter(Boolean)
		: [...DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS.args];
	const secretArg = [command, ...args].find(isSecretLikeArgument);
	if (secretArg) {
		return {
			error: providerError(
				"GEMINI_ACP_SECRET_ARGUMENT_REFUSED",
				"configure_acp",
				`Refusing to persist secret-like Gemini ACP argument '${secretArg}'. Use local Gemini authentication instead of storing credentials in Pi config.`,
			),
		};
	}

	return { settings: { enabled: true, command, args } };
}

async function runCommandExistsPreflight(
	command: string | undefined,
	commandExists: CommandExists,
): Promise<boolean> {
	if (!command) return false;
	try {
		return await commandExists(command);
	} catch {
		return false;
	}
}

function isSecretLikeArgument(value: string): boolean {
	return SECRET_FLAG_PATTERN.test(value) || SECRET_ENV_PATTERN.test(value);
}

function providerError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}
