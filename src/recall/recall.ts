import { loadConfig, recallEnabledFromConfig } from "../config/settings.js";
import type { StorageOptions } from "../storage/paths.js";
import type { StructuredError } from "../types.js";
import { runLexicalRecall } from "./lexical-recall.js";

/** One prior Gemini result returned by local recall. */
export interface RecallHit {
	responseId: string;
	tool: string;
	summary: string;
	similarity: number;
	createdAt: string;
	createdAtMs: number;
	model: string;
	inputsSummary?: string;
	matchType?: "exact" | "fts";
	recallProvider?: "fts5";
}

/** Successful local recall payload. */
export interface RecallResult {
	query: string;
	hits: RecallHit[];
	recallProvider: "fts5";
	totalCandidates: number;
}

/** Options accepted by local FTS recall. */
export interface RecallOptions extends StorageOptions {
	query: string;
	k?: number;
	minScore?: number;
	since?: string;
	tool?: string | string[];
	bypassCache?: boolean;
	signal?: AbortSignal;
	now?: number;
}

/** Result shape for local recall, including structured capability errors. */
export type RecallRunResult = RecallResult | { error: StructuredError };

/** Searches local FTS recall rows for prior Gemini results. */
export async function runRecall(
	options: RecallOptions,
): Promise<RecallRunResult> {
	const config = await loadConfig({ rootDir: options.rootDir });
	if (!recallEnabledFromConfig(config)) {
		return { error: recallUnavailable("Local recall is disabled.") };
	}
	try {
		const lexical = await runLexicalRecall(options);
		return {
			query: options.query,
			hits: lexical.hits,
			recallProvider: "fts5",
			totalCandidates: lexical.totalCandidates,
		};
	} catch (cause) {
		return {
			error: {
				code: "GEMINI_ACP_RECALL_QUERY_FAILED",
				phase: "recall_query",
				message:
					cause instanceof Error ? cause.message : "Local recall query failed.",
				retryable: true,
				provider: "gemini-acp",
			},
		};
	}
}

function recallUnavailable(message: string): StructuredError {
	return {
		code: "GEMINI_ACP_RECALL_UNAVAILABLE",
		phase: "recall_preflight",
		message: `${message} Run /gemini-config recall status for current capability details.`,
		retryable: false,
		provider: "gemini-acp",
	};
}
