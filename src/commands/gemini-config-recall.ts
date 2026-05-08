import {
	loadConfig,
	recallEnabledFromConfig,
	saveRecallEnabled,
} from "../config/settings.js";
import { defaultEmbedder } from "../recall/embedder.js";
import { lexicalRecallSummary } from "../recall/lexical-recall.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import type { StorageOptions } from "../storage/paths.js";
import { toolResult } from "../tools/result.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";

export interface GeminiConfigRecallParams {
	recallAction?: "enable" | "disable" | "status";
}

export interface GeminiConfigRecallResult {
	action: "enable" | "disable" | "status";
	recallEnabled: boolean;
	envDisabled: boolean;
	embedderAvailable: boolean;
	embedderReason?: string;
	lexicalEntries?: number;
	oldestLexicalEntry?: string;
	recallableEntries?: number;
	embeddingModels?: string[];
	queueDepth?: number;
	oldestEntry?: string;
	sqliteVecAvailable?: boolean;
}

/** Toggles local recall and background vector embedding writes. */
export async function runGeminiConfigRecall(
	params: GeminiConfigRecallParams = {},
	options: StorageOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigRecallResult>>> {
	const action = params.recallAction ?? "status";
	if (action === "enable" || action === "disable") {
		await saveRecallEnabled(action === "enable", options);
	}
	const config = await loadConfig(options);
	const embedder = await defaultEmbedder().status(options);
	const db = await openResponseCacheDb(options);
	try {
		const lexical = await lexicalRecallSummary(options);
		const embeddings = db.embeddingSummary(embedder.model);
		const oldest = db.db
			.prepare("SELECT MIN(embedded_at) AS oldest FROM embeddings")
			.get() as { oldest?: number };
		const result = {
			action,
			recallEnabled: recallEnabledFromConfig(config),
			envDisabled: process.env.PI_GEMINI_ACP_RECALL === "0",
			embedderAvailable: embedder.available,
			embedderReason: embedder.reason,
			lexicalEntries: lexical.rowCount,
			oldestLexicalEntry: lexical.oldestIndexedAtIso,
			recallableEntries: embeddings.rowCount,
			embeddingModels: embeddings.models,
			queueDepth: embeddings.queueDepth,
			oldestEntry: oldest.oldest
				? new Date(oldest.oldest).toISOString()
				: undefined,
			sqliteVecAvailable: embeddings.sqliteVecAvailable,
		} satisfies GeminiConfigRecallResult;
		return toolResult({ text: recallText(result), data: result });
	} finally {
		db.close();
	}
}

function recallText(result: GeminiConfigRecallResult): string {
	return [
		"Gemini local recall:",
		`- enabled: ${result.recallEnabled ? "yes" : "no"}`,
		`- env disabled: ${result.envDisabled ? "yes" : "no"}`,
		`- lexical FTS entries: ${result.lexicalEntries ?? 0}`,
		`- oldest lexical entry: ${result.oldestLexicalEntry ?? "none"}`,
		`- embedder: ${result.embedderAvailable ? "available" : "unavailable"}`,
		`- vector entries: ${result.recallableEntries ?? 0}`,
		`- models: ${result.embeddingModels?.join(", ") || "none"}`,
		`- queue: ${result.queueDepth ?? 0}`,
		`- oldest: ${result.oldestEntry ?? "none"}`,
		`- sqlite-vec: ${result.sqliteVecAvailable ? "loaded" : "unavailable"}`,
		result.embedderReason ? `- reason: ${result.embedderReason}` : undefined,
		result.envDisabled
			? "- note: PI_GEMINI_ACP_RECALL=0 overrides persisted settings."
			: undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}
