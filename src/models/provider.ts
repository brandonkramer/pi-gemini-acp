/**
 * @file Registers Gemini ACP as a selectable Pi model provider when ACP is configured and
 *   available.
 */
import type { Api } from "@earendil-works/pi-ai";

import { primaryAccountEnv } from "../acp/account-config.ts";
import { warmCachedGeminiAcpPromptClient } from "../acp/client-cache.ts";
import { buildGeminiAcpCommandSettings } from "../acp/settings.ts";
import { isGeminiAutoModel } from "../config/model-auto.ts";
import { GEMINI_MODEL_CHOICES } from "../config/model.ts";
import { configFromEnv, loadConfig, withDefaultGeminiAcpConfig } from "../config/settings.ts";
import { getGeminiAcpStatus } from "../config/status.ts";
import type { GeminiAcpConfig, GeminiAcpProviderSettings } from "../types.ts";
import type { PiToolsSource } from "./preamble.ts";
import { createGeminiAcpStreamSimple, promptSettingsForModel } from "./stream.ts";
import type { GeminiAcpProviderConfig, ModelProviderRegistrar } from "./types.ts";

// Pi's Api type is KnownApi | (string & {}); it accepts any string routing key.
// We use "gemini-acp" as a custom provider identifier, matching pi-claude-bridge's pattern.
const GEMINI_ACP_API: Api = "gemini-acp";
const GEMINI_ACP_DUMMY_CREDENTIAL = [
	"pi",
	"gemini",
	"acp",
	"local",
	"cli",
	"auth",
	"placeholder",
].join("-");

/** Builds a ProviderConfig for Pi's registerProvider() from current ACP config. */
export async function buildGeminiAcpProviderConfig(
	pi: PiToolsSource,
	rootDir?: string,
	loadedConfig?: GeminiAcpConfig,
): Promise<GeminiAcpProviderConfig | undefined> {
	const config =
		loadedConfig ?? withDefaultGeminiAcpConfig(configFromEnv(await loadConfig({ rootDir })));
	const settings = config.providers?.["gemini-acp"];
	if (!settings?.command) return undefined;

	const status = await getGeminiAcpStatus({ rootDir, config });
	if (!status.ready) return undefined;

	const models = buildProviderModels();
	if (models.length === 0) return undefined;

	const chatConfig = settings.chat ?? {};

	return {
		name: "Gemini ACP",
		api: GEMINI_ACP_API,
		baseUrl: "gemini-acp",
		// Pi requires apiKey when models are defined, but ACP uses local CLI auth.
		apiKey: GEMINI_ACP_DUMMY_CREDENTIAL,
		models,
		streamSimple: createGeminiAcpStreamSimple(config, settings, pi, chatConfig),
	};
}

/** Exposes all known Gemini models as Pi ProviderModelConfig entries. */
function buildProviderModels(): GeminiAcpProviderConfig["models"] {
	return GEMINI_MODEL_CHOICES.map((choice) => ({
		id: choice.id,
		name: choice.label,
		api: GEMINI_ACP_API,
		reasoning: false,
		input: ["text"],
		cost: modelCost(choice.id),
		contextWindow: 1_000_000,
		maxTokens: 8192,
	}));
}

/** Returns rough cost metadata for a Gemini model id. */
function modelCost(modelId: string): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
} {
	const m = modelId.toLowerCase();
	// gemini-auto routes each request to Flash or Pro, so the real price is unknown up front.
	// Estimate with Flash pricing, the cheaper and more common route; the UI marks costs as
	// informational.
	if (isGeminiAutoModel(m)) return { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 };
	if (m.includes("pro") && !m.includes("flash")) {
		return { input: 1.25, output: 10.0, cacheRead: 0, cacheWrite: 0 };
	}
	if (m.includes("lite") || m.includes("8b")) {
		return { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 };
	}
	return { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 };
}

/** Registers the Gemini ACP provider on Pi when preflight passes. */
export async function registerGeminiAcpModelProvider(
	pi: Partial<ModelProviderRegistrar> & Partial<ModelSelectionEvents> & PiToolsSource,
	rootDir?: string,
): Promise<void> {
	if (typeof pi.registerProvider !== "function") return;
	const loadedConfig = withDefaultGeminiAcpConfig(configFromEnv(await loadConfig({ rootDir })));
	const config = await buildGeminiAcpProviderConfig(pi, rootDir, loadedConfig);
	if (config) {
		pi.registerProvider("gemini-acp", config);
		// Best-effort prewarm of a prompt session for the current working directory so the
		// first chat turn does not pay the cold-session/new penalty.
		const settings = loadedConfig.providers?.["gemini-acp"];
		if (
			settings?.command &&
			!/^(?:1|true|yes)$/iu.test(process.env.PI_GEMINI_ACP_NO_PREWARM ?? "")
		) {
			const warm = (warmSettings: GeminiAcpProviderSettings, cwd: string) => {
				void warmCachedGeminiAcpPromptClient(
					buildGeminiAcpCommandSettings(
						warmSettings,
						primaryAccountEnv(loadedConfig.providers?.accounts),
					),
					cwd,
				).catch(() => {
					// Best-effort warmup must not fail extension activation.
				});
			};
			if (typeof pi.on === "function") {
				// Chat turns run with the model Pi selected (see promptSettingsForModel), which is
				// only known once a session starts. Warming the configured model instead would
				// spawn a process that the first turn cannot use, and would spawn one even when
				// Gemini is not the active chat model.
				const onModel = (model: PrewarmModel | undefined, cwd: string | undefined) => {
					if (model?.provider !== "gemini-acp") return;
					warm(promptSettingsForModel(settings, model.id), cwd ?? process.cwd());
				};
				pi.on("session_start", (_event, ctx) => onModel(ctx.model, ctx.cwd));
				pi.on("model_select", (event, ctx) => onModel(event.model, ctx.cwd));
			} else {
				warm(settings, process.cwd());
			}
		}
	}
}

interface PrewarmModel {
	id: string;
	provider: string;
}

/** The subset of Pi's event API used to prewarm for the selected model. */
export interface ModelSelectionEvents {
	on(
		event: "session_start",
		handler: (event: unknown, ctx: { model?: PrewarmModel; cwd?: string }) => void,
	): void;
	on(
		event: "model_select",
		handler: (event: { model?: PrewarmModel }, ctx: { cwd?: string }) => void,
	): void;
}
