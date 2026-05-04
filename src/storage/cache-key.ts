import { createHash } from "node:crypto";
import type { GeminiAcpProviderSettings } from "../types.js";

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

/** Stable JSON encoder that sorts object keys and omits undefined/function values. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

/** Computes a SHA-256 hex digest for cache keys and source hashes. */
export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
	if (value === undefined || typeof value === "function") return undefined;
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		const next = canonicalize(input[key]);
		if (next !== undefined) output[key] = next;
	}
	return output;
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
			.sort(),
	};
}
