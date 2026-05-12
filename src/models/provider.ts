/**
 * @file Registers Gemini ACP as a selectable Pi model provider when ACP is configured and
 *   available.
 */
import type { Api } from "@earendil-works/pi-ai";

import { getCachedGeminiAcpClient } from "../acp/client-cache.ts";
import type { GeminiAcpClient } from "../acp/client.ts";
import { buildGeminiAcpCommandSettings } from "../acp/settings.ts";
import { GEMINI_MODEL_CHOICES } from "../config/model.ts";
import { configFromEnv, loadConfig, withDefaultGeminiAcpConfig } from "../config/settings.ts";
import { getGeminiAcpStatus } from "../config/status.ts";
import type { PiSkillsSource } from "./preamble.ts";
import { createGeminiAcpStreamSimple } from "./stream.ts";
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
	pi: PiSkillsSource,
	rootDir?: string,
): Promise<GeminiAcpProviderConfig | undefined> {
	const config = withDefaultGeminiAcpConfig(configFromEnv(await loadConfig({ rootDir })));
	const settings = config.providers?.["gemini-acp"];
	if (!settings?.command) return undefined;

	const status = await getGeminiAcpStatus({ rootDir });
	if (!status.ready) return undefined;

	const models = buildProviderModels();
	if (models.length === 0) return undefined;

	const commandSettings = buildGeminiAcpCommandSettings(settings);
	const client: GeminiAcpClient = getCachedGeminiAcpClient(commandSettings, "prompt");
	const chatConfig = settings.chat ?? {};

	return {
		name: "Gemini ACP",
		api: GEMINI_ACP_API,
		baseUrl: "gemini-acp",
		// Pi requires apiKey when models are defined, but ACP uses local CLI auth.
		apiKey: GEMINI_ACP_DUMMY_CREDENTIAL,
		models,
		streamSimple: createGeminiAcpStreamSimple(client, pi, chatConfig),
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
	pi: Partial<ModelProviderRegistrar> & PiSkillsSource,
	rootDir?: string,
): Promise<void> {
	if (typeof pi.registerProvider !== "function") return;
	const config = await buildGeminiAcpProviderConfig(pi, rootDir);
	if (config) {
		pi.registerProvider("gemini-acp", config);
	}
}
