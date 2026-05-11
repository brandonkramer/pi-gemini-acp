import { canonicalJson } from "../utils/hash.ts";

/** Inputs used to build deterministic text for local recall indexes. */
export interface RecallTextInput {
	tool: string;
	inputs: unknown;
	result: unknown;
}

/** Builds compact deterministic text that captures what a Gemini tool call was about. */
export function buildRecallText(input: RecallTextInput): string {
	const sourceText = sourceTextValue(input.result);
	return [
		`tool: ${input.tool}`,
		`inputs: ${summarizeValue(input.inputs)}`,
		...(sourceText ? [`sources: ${truncate(sourceText, 1_000)}`] : []),
		`result: ${summarizeValue(input.result)}`,
	].join("\n");
}

function sourceTextValue(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const sourceText = (value as { sourceText?: unknown }).sourceText;
	return typeof sourceText === "string" && sourceText.trim() ? sourceText.trim() : undefined;
}

function summarizeValue(value: unknown): string {
	if (typeof value === "string") return truncate(value.trim());
	if (value === null || value === undefined) return "";
	// oxlint-disable-next-line unicorn/no-array-callback-reference -- slimValue takes one arg
	if (Array.isArray(value)) return truncate(canonicalJson(value.map(slimValue)));
	if (typeof value === "object") return truncate(canonicalJson(slimValue(value)));
	// oxlint-disable-next-line typescript/no-base-to-string -- value is a primitive (number/boolean/bigint/symbol/function) at this point; objects/arrays handled above
	return truncate(String(value));
}

function slimValue(value: unknown): unknown {
	if (typeof value === "string") return truncate(value.trim());
	if (value === null || value === undefined) return value;
	// oxlint-disable-next-line unicorn/no-array-callback-reference -- slimValue takes one arg
	if (Array.isArray(value)) return value.slice(0, 20).map(slimValue);
	if (typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(record).toSorted()) {
		if (isNoisyKey(key)) continue;
		output[key] = slimValue(record[key]);
	}
	return output;
}

function isNoisyKey(key: string): boolean {
	return key === "timing" || key === "fullOutputPath" || key === "cacheStatus";
}

function truncate(value: string, maxLength = 500): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
