import { canonicalJson } from "../utils/hash.ts";

/** Canonical searchable forms derived from a user query or tool inputs. */
export interface NormalizedRecallQuery {
	originalQuery: string;
	normalizedQuery: string;
	expandedQuery: string;
	entities: string[];
	tags: string[];
}

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"do",
	"does",
	"for",
	"from",
	"how",
	"i",
	"is",
	"it",
	"of",
	"on",
	"or",
	"so",
	"the",
	"to",
	"what",
	"why",
	"with",
]);

const TAG_RULES: Array<[tag: string, pattern: RegExp]> = [
	["llm-inference", /\b(llm|model|models|inference|inferencing)\b/iu],
	["model-serving", /\b(serving|serve|server|batching|latency|throughput)\b/iu],
	["performance", /\b(fast|faster|quick|speed|performance|latency|optimi[sz])\b/iu],
	["search", /\b(search|sources?|results?|web)\b/iu],
	["research", /\b(research|investigate|compare|explain)\b/iu],
];

/** Builds deterministic query-normalization text for local FTS recall without an embedding provider. */
export function normalizeRecallQuery(input: unknown): NormalizedRecallQuery {
	const originalQuery = originalQueryText(input);
	const normalizedQuery = normalizeText(originalQuery);
	const entities = extractEntities(originalQuery);
	const tags = tagsFor(`${originalQuery} ${normalizedQuery}`);
	return {
		originalQuery,
		normalizedQuery,
		expandedQuery: uniqueTextParts([normalizedQuery, ...entities, ...tags]).join(" "),
		entities,
		tags,
	};
}

/** Returns a safe FTS5 MATCH expression for normalized query tokens. */
export function ftsMatchExpression(query: string): string | undefined {
	const tokens = searchableTokens(query);
	return tokens.length > 0 ? tokens.map((token) => `"${token}"*`).join(" OR ") : undefined;
}

/** Tokenizes normalized text for overlap scoring. */
export function searchableTokens(text: string): string[] {
	return uniqueTextParts(
		normalizeText(text)
			.split(" ")
			.filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
	);
}

function originalQueryText(input: unknown): string {
	if (typeof input === "string") return input.trim();
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		if (input === undefined || input === null) return "";
		// oxlint-disable-next-line typescript/no-base-to-string -- input is a primitive at this point (objects handled above; arrays handled by ternary branch)
		return Array.isArray(input) ? JSON.stringify(input) : String(input);
	}
	const record = input as Record<string, unknown>;
	for (const key of ["query", "prompt", "content", "text"] as const) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return canonicalJson(input);
}

function normalizeText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/https?:\/\//gu, " ")
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

function extractEntities(text: string): string[] {
	const entities: string[] = [];
	for (const match of text.matchAll(/\b[a-z0-9-]+\.(?:ai|com|dev|io|org|net)\b/giu)) {
		entities.push(match[0].toLowerCase());
	}
	return uniqueTextParts(entities);
}

function tagsFor(text: string): string[] {
	const tags: string[] = [];
	for (const [tag, pattern] of TAG_RULES) {
		if (pattern.test(text)) tags.push(tag);
	}
	return tags;
}

function uniqueTextParts(parts: string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const part of parts) {
		const value = part.trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		output.push(value);
	}
	return output;
}
