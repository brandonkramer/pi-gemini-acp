import { loadConfig, recallEnabledFromConfig, saveRecallEnabled } from "../config/settings.ts";
import { lexicalRecallSummary } from "../recall/lexical-recall.ts";
import type { StorageOptions } from "../storage/paths.ts";
import { toolResult } from "../tools/result.ts";
import type { PiToolShell, ResultEnvelope } from "../types.ts";

export interface GeminiConfigRecallParams {
	recallAction?: "enable" | "disable" | "status";
}

export interface GeminiConfigRecallResult {
	action: "enable" | "disable" | "status";
	recallEnabled: boolean;
	envDisabled: boolean;
	lexicalEntries?: number;
	oldestLexicalEntry?: string;
}

/** Toggles local FTS recall. */
export async function runGeminiConfigRecall(
	params: GeminiConfigRecallParams = {},
	options: StorageOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigRecallResult>>> {
	const action = params.recallAction ?? "status";
	if (action === "enable" || action === "disable") {
		await saveRecallEnabled(action === "enable", options);
	}
	const config = await loadConfig(options);
	const lexical = await lexicalRecallSummary(options);
	const result = {
		action,
		recallEnabled: recallEnabledFromConfig(config),
		envDisabled: process.env.PI_GEMINI_ACP_RECALL === "0",
		lexicalEntries: lexical.rowCount,
		oldestLexicalEntry: lexical.oldestIndexedAtIso,
	} satisfies GeminiConfigRecallResult;
	return toolResult({ text: recallText(result), data: result });
}

function recallText(result: GeminiConfigRecallResult): string {
	return [
		"Gemini local recall:",
		`- enabled: ${result.recallEnabled ? "yes" : "no"}`,
		`- env disabled: ${result.envDisabled ? "yes" : "no"}`,
		`- lexical FTS entries: ${result.lexicalEntries ?? 0}`,
		`- oldest lexical entry: ${result.oldestLexicalEntry ?? "none"}`,
		result.envDisabled ? "- note: PI_GEMINI_ACP_RECALL=0 overrides persisted settings." : undefined,
	]
		.filter(Boolean)
		.join("\n");
}
