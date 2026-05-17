import { getCachedGeminiAcpClient } from "../acp/client-cache.ts";
import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptPart,
	GeminiAcpPromptRequest,
} from "../acp/client.ts";
import { emitGeminiBackendProgress, withGeminiBackendProgress } from "../acp/prompt-progress.ts";
import { buildGeminiAcpCommandSettings } from "../acp/settings.ts";
import { GeminiApiKeyClient } from "../api/client.ts";
import { geminiApiKeyConfigured } from "../api/config.ts";
import {
	isQuotaExhausted,
	isQuotaExhaustedError,
	recordQuotaExhausted,
} from "../api/quota-cache.ts";
import { apiModelFromLabel, geminiAcpModelLabel } from "../config/model-label.ts";
import { configFromEnv, loadConfig, withDefaultGeminiAcpConfig } from "../config/settings.ts";
import {
	type GeminiAcpAuthProbe,
	preflightGeminiAcpProvider,
	type StatusCommandChecker,
} from "../config/status.ts";
import { storeResult } from "../storage/results.ts";
import type { GeminiAcpConfig, GeminiAcpProviderSettings, StructuredError } from "../types.ts";
import { promptWorkflowProgressEmitter } from "./progress-emitter.ts";
import {
	classifyProviderError,
	providerError,
	type ProviderErrorClassificationOptions,
} from "./provider-result.ts";

export const PROMPT_RESPONSE_INLINE_LIMIT = 4_000;

export type PromptRequestArgument = string | number | boolean | undefined;

/** Sanitized request metadata shown in progress without exposing full prompt content. */
export interface PromptRequestSummary {
	toolName: `gemini_${string}`;
	action: string;
	subject?: string;
	arguments?: Record<string, PromptRequestArgument>;
}

/** Inputs for a generic Gemini ACP prompt run. */
export interface PromptOptions {
	prompt: string;
	config?: GeminiAcpConfig;
	rootDir?: string;
	cwd?: string;
	inlineLimit?: number;
	useDefaultConfig?: boolean;
	requestSummary?: PromptRequestSummary;
	/**
	 * When false, ACP-unavailable and quota-exhausted preflights return the structured error instead
	 * of falling back to GeminiApiKeyClient. File and image analysis MUST set this to false because
	 * the REST API client silently drops resource_link parts.
	 */
	allowApiKeyFallback?: boolean;
}

/** Injectable dependencies for prompt tests and future shared status wiring. */
export interface PromptDeps {
	geminiAcpClient?: GeminiAcpClient;
	geminiAcpClientFactory?: (settings: GeminiAcpCommandSettings) => GeminiAcpClient;
	geminiApiKeyClientFactory?: () => GeminiAcpClient;
	commandExists?: StatusCommandChecker;
	authProbe?: GeminiAcpAuthProbe;
}

/** Streaming or phase update emitted by the prompt workflow. */
export type PromptWorkflowUpdate =
	| {
			type: "progress";
			phase: string;
			text: string;
			request?: PromptRequestSummary;
	  }
	| { type: "chunk"; text: string; accumulatedText: string };

/** Compact prompt result returned to tools; large full text is stored by responseId. */
export interface PromptRunResult {
	provider: "gemini-acp";
	text: string;
	responseLength: number;
	truncated: boolean;
	model?: string;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

export type PromptUpdateHandler = (update: PromptWorkflowUpdate) => void | Promise<void>;

/** Result returned by the shared provider prompt turn before per-tool shaping. */
export interface ProviderPromptRunResult {
	text: string;
	model?: string;
	error?: StructuredError;
}

/** Context supplied to custom prompt executors such as resource-link tools. */
export interface ProviderPromptContext {
	settings: GeminiAcpProviderSettings | undefined;
	commandSettings: GeminiAcpCommandSettings;
	request: GeminiAcpPromptRequest;
	requestSummary?: PromptRequestSummary;
}

/** Options for the shared Gemini ACP prompt orchestration seam. */
export interface ProviderPromptOptions extends PromptOptions {
	parts?: GeminiAcpPromptPart[];
	requireSearchGrounding?: boolean;
	/**
	 * When false, ACP-unavailable and quota-exhausted preflights return the structured error instead
	 * of falling back to GeminiApiKeyClient. File and image analysis MUST set this to false because
	 * the REST API client silently drops resource_link parts.
	 */
	allowApiKeyFallback?: boolean;
	commandSettingsTransform?: (settings: GeminiAcpCommandSettings) => GeminiAcpCommandSettings;
	prePromptCheck?: (context: Omit<ProviderPromptContext, "request">) => StructuredError | undefined;
	errorClassification?: ProviderErrorClassificationOptions;
	promptExecutor?: (
		context: ProviderPromptContext,
		signal?: AbortSignal,
		onUpdate?: PromptUpdateHandler,
	) => Promise<string | ProviderPromptRunResult>;
}

/** Executes provider preflight and one Gemini ACP prompt turn for prompt-family tools. */
export async function runProviderPrompt(
	options: ProviderPromptOptions,
	deps: PromptDeps = {},
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<ProviderPromptRunResult> {
	await onUpdate?.({
		type: "progress",
		phase: "provider_preflight",
		text: "Checking Gemini ACP configuration.",
	});
	const loadedConfig =
		options.config ?? configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const config =
		options.useDefaultConfig === false ? loadedConfig : withDefaultGeminiAcpConfig(loadedConfig);
	const settings = config.providers?.["gemini-acp"];
	const preflight = await preflightGeminiAcpProvider(settings, {
		commandExists: deps.commandExists,
		requireSearchGrounding: options.requireSearchGrounding,
		rootDir: options.rootDir,
		signal,
		authProbe: deps.authProbe,
		persistAuthConfirmation: !options.config,
	});
	const baseCommandSettings = buildGeminiAcpCommandSettings(settings);
	const commandSettings =
		options.commandSettingsTransform?.(baseCommandSettings) ?? baseCommandSettings;
	const model = geminiAcpModelLabel(settings, commandSettings);
	const quotaExhausted = isQuotaExhausted(model);
	const fallbackAllowed = options.allowApiKeyFallback !== false;
	if (
		fallbackAllowed &&
		preflight &&
		isAcpFallbackError(preflight) &&
		geminiApiKeyConfigured(config)
	) {
		return await runApiKeyPrompt(options, deps, config, model, signal, onUpdate);
	}
	if (fallbackAllowed && quotaExhausted && geminiApiKeyConfigured(config)) {
		return await runApiKeyPrompt(options, deps, config, model, signal, onUpdate);
	}
	if (preflight) return { text: "", error: preflight };

	const prePromptError = options.prePromptCheck?.({
		settings,
		commandSettings,
	});
	if (prePromptError) return { text: "", error: prePromptError };
	const request: GeminiAcpPromptRequest =
		options.parts && options.parts.length > 0
			? { parts: options.parts, cwd: options.cwd }
			: { prompt: options.prompt, cwd: options.cwd };
	const requestSummary = promptRequestSummary(options, model);
	const context: ProviderPromptContext = {
		settings,
		commandSettings,
		request,
		requestSummary,
	};
	try {
		await onUpdate?.({
			type: "progress",
			phase: "provider_prompt",
			text: formatPromptRequestSummary(requestSummary),
			request: requestSummary,
		});
		const executed = options.promptExecutor
			? await options.promptExecutor(context, signal, onUpdate)
			: await defaultPromptExecutor(context, deps, signal, onUpdate);
		return typeof executed === "string" ? { text: executed, model } : { ...executed, model };
	} catch (cause) {
		if (isQuotaExhaustedError(cause)) {
			recordQuotaExhausted(model, cause instanceof Error ? cause.message : String(cause));
			if (fallbackAllowed && geminiApiKeyConfigured(config)) {
				return await runApiKeyPrompt(options, deps, config, model, signal, onUpdate);
			}
		}
		const classified = classifyProviderError(cause, signal, options.errorClassification);
		return {
			text: "",
			error: providerError(classified.code, "provider_prompt", classified.message, {
				retryable: classified.retryable,
				cause,
			}),
		};
	}
}

/** Executes a plain text prompt through the configured local Gemini ACP provider. */
export async function runPrompt(
	options: PromptOptions,
	deps: PromptDeps = {},
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<PromptRunResult> {
	if (!options.prompt.trim()) {
		return promptError("GEMINI_ACP_EMPTY_PROMPT", "input_validation", "Prompt text is required.");
	}
	const promptResult = await runProviderPrompt(options, deps, signal, onUpdate);
	return promptResult.error
		? { ...emptyPromptResult(), error: promptResult.error }
		: {
				...(await compactPromptResult(promptResult.text, options)),
				model: promptResult.model,
			};
}

async function defaultPromptExecutor(
	context: ProviderPromptContext,
	deps: PromptDeps,
	signal: AbortSignal | undefined,
	onUpdate: PromptUpdateHandler | undefined,
): Promise<string> {
	const client =
		deps.geminiAcpClient ??
		(deps.geminiAcpClientFactory ?? ((settings) => getCachedGeminiAcpClient(settings)))(
			context.commandSettings,
		);
	const header = context.requestSummary
		? formatPromptRequestSummary(context.requestSummary)
		: undefined;
	await emitGeminiBackendProgress(
		promptWorkflowProgressEmitter(onUpdate, "provider_wait"),
		"waiting",
		header,
	);
	const wrappedOnUpdate = onUpdate
		? withGeminiBackendProgress(
				async (chunk) => await onUpdate(chunk),
				promptWorkflowProgressEmitter(onUpdate, "provider_stream"),
				header,
			)
		: undefined;
	return await client.prompt(context.request, signal, wrappedOnUpdate);
}

async function runApiKeyPrompt(
	options: ProviderPromptOptions,
	deps: PromptDeps,
	config: GeminiAcpConfig,
	model: string,
	signal: AbortSignal | undefined,
	onUpdate: PromptUpdateHandler | undefined,
): Promise<ProviderPromptRunResult> {
	const fallbackNote = isQuotaExhausted(model)
		? "ACP quota exhausted, falling back to API key."
		: "ACP unavailable, falling back to API key.";
	const requestSummary = promptRequestSummary(options, model);
	const header = formatPromptRequestSummary(requestSummary);
	await onUpdate?.({
		type: "progress",
		phase: "provider_preflight",
		text: `${header}\n\n● ${fallbackNote}`,
		request: requestSummary,
	});
	const client =
		deps.geminiApiKeyClientFactory?.() ??
		new GeminiApiKeyClient({ config, model: apiModelFromLabel(model) });
	const request: GeminiAcpPromptRequest =
		options.parts && options.parts.length > 0
			? { parts: options.parts, cwd: options.cwd }
			: { prompt: options.prompt, cwd: options.cwd };
	try {
		const text = await client.prompt(request, signal, async (chunk) => {
			await onUpdate?.(chunk);
		});
		return { text, model };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "Gemini API key call failed.";
		// UNSUPPORTED_TRANSPORT is a coding error (non-text parts reached the API-key path) and must
		// surface as its own code so callers can distinguish it from a generic API-key failure.
		const isUnsupportedTransport = /UNSUPPORTED_TRANSPORT/iu.test(message);
		return {
			text: "",
			error: providerError(
				isUnsupportedTransport ? "GEMINI_API_KEY_UNSUPPORTED_TRANSPORT" : "GEMINI_API_KEY_FAILED",
				"provider_prompt",
				message,
				{ retryable: !isUnsupportedTransport, cause },
			),
		};
	}
}

function isAcpFallbackError(error: StructuredError): boolean {
	return (
		error.code === "GEMINI_ACP_MISSING_CONFIG" ||
		error.code === "GEMINI_ACP_COMMAND_NOT_FOUND" ||
		error.code === "GEMINI_ACP_UNAUTHENTICATED" ||
		error.code === "GEMINI_ACP_SEARCH_UNAVAILABLE"
	);
}

async function compactPromptResult(text: string, options: PromptOptions): Promise<PromptRunResult> {
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

function promptRequestSummary(options: PromptOptions, model: string): PromptRequestSummary {
	const summary = options.requestSummary ?? {
		toolName: "gemini_prompt" as const,
		action: "Sending prompt",
		arguments: { promptLength: options.prompt.length },
	};
	return {
		...summary,
		arguments: { ...summary.arguments, model },
	};
}

/** Formats sanitized prompt request metadata for visible progress text. */
export function formatPromptRequestSummary(summary: PromptRequestSummary): string {
	const args = Object.entries(summary.arguments ?? {}).flatMap(([key, value]) =>
		value === undefined ? [] : `${key} ${formatRequestArgument(value)}`,
	);
	const model = summary.arguments?.model;
	const withoutModel = args.filter((arg) => !arg.startsWith("model "));
	const subject = summary.subject ? `: "${truncateSummaryText(summary.subject)}"` : "";
	const withArgs = withoutModel.length > 0 ? ` with ${withoutModel.join(", ")}` : "";
	const via = model ? ` via ${formatRequestArgument(model)}` : "";
	return `${summary.action}${subject}${withArgs}${via}.`;
}

function truncateSummaryText(value: string): string {
	return value.length <= 160 ? value : `${value.slice(0, 159)}…`;
}

function formatRequestArgument(value: Exclude<PromptRequestArgument, undefined>): string {
	return typeof value === "string" ? value : String(value);
}

function emptyPromptResult(): PromptRunResult {
	return {
		provider: "gemini-acp",
		text: "",
		responseLength: 0,
		truncated: false,
	};
}

function promptError(code: string, phase: string, message: string): PromptRunResult {
	return {
		...emptyPromptResult(),
		error: providerError(code, phase, message, { retryable: false }),
	};
}
