import type { ExtractProviderMetadata } from "./extract.js";

/** Parses raw, fenced, or prose-wrapped JSON from Gemini text. */
export function parseExtractionPayload(
	text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
	const trimmed = text.trim();
	if (!trimmed)
		return { ok: false, message: "Gemini returned an empty response." };
	const direct = tryParseJson(trimmed);
	if (direct.ok) return direct;

	const fencePattern = /```(?:json)?\s*([\s\S]*?)```/giu;
	for (const match of trimmed.matchAll(fencePattern)) {
		const fenced = match[1]?.trim();
		if (!fenced) continue;
		const parsed = tryParseJson(fenced);
		if (parsed.ok) return parsed;
	}

	for (const start of jsonStartIndexes(trimmed)) {
		const end = findJsonEnd(trimmed, start);
		if (end < 0) continue;
		const parsed = tryParseJson(trimmed.slice(start, end + 1));
		if (parsed.ok) return parsed;
	}
	return { ok: false, message: "Gemini response did not contain valid JSON." };
}

/** Normalizes optional provider metadata from camelCase or snake_case payload fields. */
export function normalizeExtractMetadata(
	value: unknown,
): ExtractProviderMetadata | undefined {
	const record = asRecord(value);
	const raw =
		asRecord(record?.providerMetadata) ??
		asRecord(record?.provider_metadata) ??
		asRecord(record?.metadata);
	if (!raw) return undefined;
	return {
		provider: firstString(raw, ["provider"]),
		model: firstString(raw, ["model"]),
		modelName: firstString(raw, ["modelName", "model_name"]),
		responseId: firstString(raw, ["responseId", "response_id"]),
		raw,
	};
}

function tryParseJson(
	text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (cause) {
		return {
			ok: false,
			message: cause instanceof Error ? cause.message : "Invalid JSON.",
		};
	}
}

function jsonStartIndexes(text: string): number[] {
	const starts: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "{" || text[index] === "[") starts.push(index);
	}
	return starts;
}

function findJsonEnd(text: string, start: number): number {
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === open) depth += 1;
		else if (char === close) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}
