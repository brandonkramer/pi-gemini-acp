import { canonicalJson } from "../storage/cache-key.js";

/** Inputs used to build deterministic text for local recall indexes. */
export interface RecallTextInput {
	tool: string;
	inputs: unknown;
	result: unknown;
}

/** Builds compact deterministic text that captures what a Gemini tool call was about. */
export function buildRecallText(input: RecallTextInput): string {
	return [
		`tool: ${input.tool}`,
		`inputs: ${summarizeValue(input.inputs)}`,
		`result: ${summarizeValue(input.result)}`,
	].join("\n");
}

function summarizeValue(value: unknown): string {
	if (typeof value === "string") return truncate(value.trim());
	if (value === null || value === undefined) return "";
	if (Array.isArray(value))
		return truncate(canonicalJson(value.map(slimValue)));
	if (typeof value === "object")
		return truncate(canonicalJson(slimValue(value)));
	return truncate(String(value));
}

function slimValue(value: unknown): unknown {
	if (typeof value === "string") return truncate(value.trim());
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.slice(0, 20).map(slimValue);
	if (typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
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
