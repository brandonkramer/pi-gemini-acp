import { configFromEnv, loadConfig } from "../config/settings.ts";
import type { StorageOptions } from "../storage/paths.ts";

/** Result of one embedding call. */
export interface EmbeddingResult {
	model: string;
	dim: number;
	embedding: number[];
}

/** Runtime status for the optional embedding backend. */
export interface EmbedderStatus {
	available: boolean;
	model: string;
	dim: number;
	reason?: string;
}

/** Narrow seam for task-05 background embedding infrastructure. */
export interface Embedder {
	status(options?: StorageOptions): Promise<EmbedderStatus>;
	embed(text: string, signal?: AbortSignal): Promise<EmbeddingResult>;
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-004";
const DEFAULT_EMBEDDING_DIM = 768;

/**
 * Default embedder that honestly reports unavailable support.
 *
 * Gemini ACP does not currently expose an embedding JSON-RPC method in this package's narrow client
 * surface. Rather than assuming credentials or adding a heavy local model, task 05 ships the
 * queue/vector seam and leaves writes disabled until a real Gemini embedding transport is added.
 */
export class UnavailableGeminiEmbedder implements Embedder {
	async status(options: StorageOptions = {}): Promise<EmbedderStatus> {
		const configuredModel = configFromEnv(await loadConfig(options)).providers?.["gemini-acp"]
			?.model;
		return {
			available: false,
			model: configuredModel ?? DEFAULT_EMBEDDING_MODEL,
			dim: DEFAULT_EMBEDDING_DIM,
			reason:
				"Gemini ACP embedding transport is not exposed; recall embeddings are disabled until a supported embedder is configured.",
		};
	}

	async embed(): Promise<EmbeddingResult> {
		throw new Error("Gemini ACP embedding transport is not available in this package version.");
	}
}

/** Returns the production embedder used by background recall jobs. */
export function defaultEmbedder(): Embedder {
	return new UnavailableGeminiEmbedder();
}
