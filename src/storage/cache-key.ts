import type { GeminiAcpProviderSettings } from "../types.ts";
import { canonicalJson, sha256Hex } from "../utils/hash.ts";

/** Inputs that uniquely identify a cacheable Gemini tool response. */
export interface CacheKeyInput {
	tool: string;
	inputs: unknown;
	model?: string;
	providerSettings?: GeminiAcpProviderSettings;
	sourceHash?: string;
}

/** Deterministically derives a response-cache key without depending on object insertion order. */
export function deriveCacheKey(input: CacheKeyInput): {
	cacheKey: string;
	providerHash: string;
	sourceHash?: string;
} {
	const providerHash = sha256Hex(
		canonicalJson(providerSettingsFingerprint(input.providerSettings)),
	);
	const cacheKey = sha256Hex(
		canonicalJson({
			tool: input.tool,
			inputs: input.inputs,
			model: input.model,
			providerHash,
			sourceHash: input.sourceHash,
		}),
	);
	return { cacheKey, providerHash, sourceHash: input.sourceHash };
}

function providerSettingsFingerprint(
	settings: GeminiAcpProviderSettings | undefined,
): Record<string, unknown> {
	return {
		command: settings?.command,
		args: settings?.args,
		model: settings?.model,
		authenticated: settings?.authenticated,
		searchGroundingAvailable: settings?.searchGroundingAvailable,
		requiresSearchGrounding: settings?.requiresSearchGrounding,
		fileAnalysisAvailable: settings?.fileAnalysisAvailable,
		imageInputAvailable: settings?.imageInputAvailable,
		modelSelectionAvailable: settings?.modelSelectionAvailable,
		permissionPolicy: settings?.permissionPolicy,
		envKeys: Object.keys(process.env)
			.filter((key) => key.startsWith("PI_GEMINI_ACP_"))
			.toSorted(),
	};
}
