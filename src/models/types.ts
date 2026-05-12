/** @file Types for Pi model-provider registration. */
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/** Minimal provider config shape accepted by Pi's ExtensionAPI.registerProvider(). */
export interface GeminiAcpProviderConfig {
	name: string;
	api: Api;
	baseUrl: string;
	apiKey: string;
	models: GeminiAcpModelConfig[];
	streamSimple: GeminiAcpStreamSimple;
}

/** Model config entry for a selectable Gemini ACP model. */
export interface GeminiAcpModelConfig {
	id: string;
	name: string;
	api: Api;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** Pi streamSimple signature bridged to Gemini ACP. */
export type GeminiAcpStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Registrar capability needed from the Pi extension API. */
export interface ModelProviderRegistrar {
	registerProvider(name: string, config: GeminiAcpProviderConfig): void;
}
