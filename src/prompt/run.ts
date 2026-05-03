import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
} from "../acp/client.js";
import { getCachedGeminiAcpClient } from "../acp/client-cache.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import {
	preflightGeminiAcpProvider,
	type StatusCommandChecker,
} from "../config/status.js";
import { storeResult } from "../storage/results.js";
import type { GeminiAcpConfig, StructuredError } from "../types.js";

export const PROMPT_RESPONSE_INLINE_LIMIT = 4_000;

/** Inputs for a generic Gemini ACP prompt run. */
export interface PromptOptions {
	prompt: string;
	config?: GeminiAcpConfig;
	rootDir?: string;
	cwd?: string;
	inlineLimit?: number;
	useDefaultConfig?: boolean;
}

/** Injectable dependencies for prompt tests and future shared status wiring. */
export interface PromptDeps {
	geminiAcpClient?: GeminiAcpClient;
	geminiAcpClientFactory?: (
		settings: GeminiAcpCommandSettings,
	) => GeminiAcpClient;
	commandExists?: StatusCommandChecker;
}

/** Streaming or phase update emitted by the prompt workflow. */
export type PromptWorkflowUpdate =
	| { type: "progress"; phase: string; text: string }
	| { type: "chunk"; text: string; accumulatedText: string };

/** Compact prompt result returned to tools; large full text is stored by responseId. */
export interface PromptRunResult {
	provider: "gemini-acp";
	text: string;
	responseLength: number;
	truncated: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

export type PromptUpdateHandler = (
	update: PromptWorkflowUpdate,
) => void | Promise<void>;

/** Executes a plain text prompt through the configured local Gemini ACP provider. */
export async function runPrompt(
	options: PromptOptions,
	deps: PromptDeps = {},
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<PromptRunResult> {
	if (!options.prompt.trim()) {
		return promptError(
			"GEMINI_ACP_EMPTY_PROMPT",
			"input_validation",
			"Prompt text is required.",
		);
	}

	await onUpdate?.({
		type: "progress",
		phase: "provider_preflight",
		text: "Checking Gemini ACP configuration.",
	});
	const loadedConfig =
		options.config ??
		configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const config =
		options.useDefaultConfig === false
			? loadedConfig
			: withDefaultGeminiAcpConfig(loadedConfig);
	const settings = config.providers?.["gemini-acp"];
	const preflight = await preflightGeminiAcpProvider(settings, {
		commandExists: deps.commandExists,
	});
	if (preflight) return { ...emptyPromptResult(), error: preflight };

	const commandSettings = buildGeminiAcpCommandSettings(settings);
	const client =
		deps.geminiAcpClient ??
		(
			deps.geminiAcpClientFactory ??
			((settings) => getCachedGeminiAcpClient(settings, "prompt"))
		)(commandSettings);
	try {
		await onUpdate?.({
			type: "progress",
			phase: "provider_prompt",
			text: "Sending prompt to Gemini ACP.",
		});
		const text = await client.prompt(
			{ prompt: options.prompt, cwd: options.cwd },
			signal,
			async (chunk) => {
				await onUpdate?.(chunk);
			},
		);
		return await compactPromptResult(text, options);
	} catch (cause) {
		return {
			...emptyPromptResult(),
			error: {
				...promptProviderError(
					isAbortError(cause) ? "GEMINI_ACP_ABORTED" : "GEMINI_ACP_FAILED",
					"provider_prompt",
					isAbortError(cause)
						? "Gemini ACP prompt was aborted."
						: cause instanceof Error
							? cause.message
							: "Gemini ACP prompt failed.",
					isAbortError(cause),
				),
				cause,
			},
		};
	}
}

async function compactPromptResult(
	text: string,
	options: PromptOptions,
): Promise<PromptRunResult> {
	const responseLength = text.length;
	const inlineLimit = options.inlineLimit ?? PROMPT_RESPONSE_INLINE_LIMIT;
	if (responseLength <= inlineLimit) {
		return {
			provider: "gemini-acp",
			text,
			responseLength,
			truncated: false,
		};
	}
	const stored = await storeResult(
		{ provider: "gemini-acp", prompt: options.prompt, text },
		{ rootDir: options.rootDir },
	);
	return {
		provider: "gemini-acp",
		text: `${text.slice(0, inlineLimit)}…`,
		responseLength,
		truncated: true,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

function emptyPromptResult(): PromptRunResult {
	return {
		provider: "gemini-acp",
		text: "",
		responseLength: 0,
		truncated: false,
	};
}

function promptError(
	code: string,
	phase: string,
	message: string,
): PromptRunResult {
	return {
		...emptyPromptResult(),
		error: promptProviderError(code, phase, message),
	};
}

function promptProviderError(
	code: string,
	phase: string,
	message: string,
	retryable = false,
): StructuredError {
	return { code, phase, message, retryable, provider: "gemini-acp" };
}

function isAbortError(value: unknown): boolean {
	return value instanceof DOMException
		? value.name === "AbortError"
		: value instanceof Error && value.name === "AbortError";
}
