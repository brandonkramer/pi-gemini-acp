import { isNonEmptyString, isRecord } from "../utils/guards.ts";
import { truncateToolText } from "../utils/text.ts";
/** @file Extracts concise source notes and trust signals from stored-result payloads. */
import type { QualitySignals, SourceNote, StoredResultKind } from "./shape-types.ts";

const FINDING_LIMIT = 4;

export interface PayloadView {
	value: unknown;
	originalTopLevelKeys: string[];
	unwrapNotes: string[];
}

export interface SourceDetail {
	note: SourceNote;
	text: string;
	citations: string[];
}

export function unwrapStoredPayload(value: unknown): PayloadView {
	const originalTopLevelKeys = topLevelKeys(value);
	if (!isRecord(value)) return { value, originalTopLevelKeys, unwrapNotes: [] };
	const shell = recordField(value, "shell");
	const shellDetails = shell ? recordField(shell, "details") : undefined;
	if (shellDetails && "data" in shellDetails && shellDetails.data !== undefined) {
		return {
			value: shellDetails.data,
			originalTopLevelKeys,
			unwrapNotes: ["Stored payload is a cached tool shell; overview uses shell.details.data."],
		};
	}
	const result = recordField(value, "result");
	if (result) {
		return {
			value: result,
			originalTopLevelKeys,
			unwrapNotes: ["Stored payload is a cached result wrapper; overview uses result."],
		};
	}
	return { value, originalTopLevelKeys, unwrapNotes: [] };
}

export function detectStoredResultKind(value: unknown): StoredResultKind {
	if (!isRecord(value)) return "unknown";
	if (Array.isArray(value.sources) && Array.isArray(value.findings)) return "research";
	if (Array.isArray(value.results)) return "search";
	if (
		Array.isArray(value.files) ||
		isRecord(value.image) ||
		value.tool === "gemini_file_analyze" ||
		value.tool === "gemini_image_describe"
	) {
		return "analysis";
	}
	if (
		isNonEmptyString(value.text) ||
		isNonEmptyString(value.rawText) ||
		isNonEmptyString(value.summary) ||
		isNonEmptyString(value.caption)
	) {
		return "ask";
	}
	return "unknown";
}

export function collectSourceDetails(value: unknown, kind: StoredResultKind): SourceDetail[] {
	if (!isRecord(value)) return [];
	if (kind === "research") return collectResearchSources(value);
	if (kind === "search") return collectSearchSources(value);
	const direct = collectDirectSource(value);
	return direct.length > 0 ? direct : collectAnalysisSources(value);
}

export function resultSummary(value: unknown, kind: StoredResultKind, sourceCount: number): string {
	if (!isRecord(value)) return `Stored ${typeof value} result.`;
	if (kind === "search") return `Search result contains ${sourceCount} source(s).`;
	if (kind === "research") {
		return stringField(value, "summary") ?? `Research result contains ${sourceCount} source(s).`;
	}
	return (
		stringField(value, "summary") ??
		stringField(value, "caption") ??
		textSummary(stringField(value, "text") ?? stringField(value, "rawText")) ??
		`Stored result with keys: ${topLevelKeys(value).join(", ") || "none"}.`
	);
}

export function resultQuery(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return stringField(value, "query") ?? textSummary(stringField(value, "prompt"));
}

export function keyFindings(value: unknown, kind: StoredResultKind): string[] {
	if (!isRecord(value)) return [];
	if (kind === "research") {
		return recordsField(value, "findings")
			.map((finding) => stringField(finding, "text"))
			.filter(isNonEmptyString)
			.slice(0, FINDING_LIMIT)
			.map((finding) => truncateToolText(finding, 260));
	}
	if (kind === "search") {
		return recordsField(value, "results")
			.slice(0, FINDING_LIMIT)
			.map(searchFinding)
			.filter(isNonEmptyString);
	}
	return textFindings(
		stringField(value, "summary") ??
			stringField(value, "caption") ??
			stringField(value, "text") ??
			stringField(value, "rawText"),
	);
}

export function buildQualitySignals(
	value: unknown,
	kind: StoredResultKind,
	sourceCount: number,
	findings: string[],
	payload: PayloadView,
): QualitySignals {
	const partialFailures = partialFailuresFromValue(value);
	const knownGaps = [...payload.unwrapNotes];
	if ((kind === "research" || kind === "search") && sourceCount === 0) {
		knownGaps.push("No source records are stored with this result.");
	}
	if (sourceCount > 0 && !hasRetrievedAt(value)) {
		knownGaps.push("Source retrieval timestamps are not available in the stored payload.");
	}
	return {
		confidence: confidenceFor(kind, sourceCount, findings.length, partialFailures.length),
		coverage: coverageFor(kind, sourceCount),
		freshness: "unknown",
		knownGaps,
		conflicts: [],
		partialFailures,
	};
}

function collectResearchSources(value: Record<string, unknown>): SourceDetail[] {
	const findings = recordsField(value, "findings");
	const citations = recordsField(value, "citations");
	const seen = new Set<string>();
	return recordsField(value, "sources").map((source, index) =>
		researchSourceDetail(source, index, seen, findings, citations),
	);
}

function researchSourceDetail(
	source: Record<string, unknown>,
	index: number,
	seen: Set<string>,
	findings: Record<string, unknown>[],
	citations: Record<string, unknown>[],
): SourceDetail {
	const id = stableSourceId(stringField(source, "id"), index, seen);
	const finding = firstFindingForSource(findings, id);
	return {
		note: {
			id,
			title: stringField(source, "title"),
			uri: stringField(source, "url") ?? stringField(source, "uri"),
			excerpt: excerptFromRecord(source),
			relevance: finding
				? `Finding: ${truncateToolText(finding, 180)}`
				: "Research source included in the stored result.",
			retrievedAt: stringField(source, "retrievedAt"),
			sourceType: "research_source",
		},
		text: stringField(source, "text") ?? stringField(source, "snippet") ?? "",
		citations: citationsForSource(citations, id),
	};
}

function firstFindingForSource(
	findings: Record<string, unknown>[],
	sourceId: string,
): string | undefined {
	return findings
		.map((finding) =>
			stringField(finding, "sourceId") === sourceId ? stringField(finding, "text") : undefined,
		)
		.find(isNonEmptyString);
}

function citationsForSource(citations: Record<string, unknown>[], sourceId: string): string[] {
	return citations
		.map((citation) =>
			stringField(citation, "sourceId") === sourceId ? citationSummary(citation) : undefined,
		)
		.filter(isNonEmptyString);
}

function collectSearchSources(value: Record<string, unknown>): SourceDetail[] {
	const seen = new Set<string>();
	return recordsField(value, "results").map((result, index) => {
		const id = stableSourceId(undefined, index, seen);
		const ranking = numberField(result, "ranking") ?? index + 1;
		const provider = stringField(recordField(result, "source"), "provider");
		const snippet = stringField(result, "snippet");
		return {
			note: {
				id,
				title: stringField(result, "title") ?? stringField(result, "normalizedUrl"),
				uri: stringField(result, "url") ?? stringField(result, "normalizedUrl"),
				excerpt: snippet ? truncateToolText(snippet, 240) : undefined,
				relevance: `Search result ranked #${ranking}${provider ? ` by ${provider}` : ""}.`,
				sourceType: "search_result",
			},
			text: snippet ?? "",
			citations: [],
		};
	});
}

function collectDirectSource(value: Record<string, unknown>): SourceDetail[] {
	const source = recordField(value, "source");
	if (!source) return [];
	const text =
		stringField(value, "preparedSource") ??
		stringField(source, "text") ??
		stringField(source, "snippet") ??
		"";
	return [
		{
			note: {
				id: "s1",
				title: stringField(source, "title") ?? stringField(source, "url"),
				uri: stringField(source, "url") ?? stringField(source, "uri"),
				excerpt: excerptFromText(text),
				relevance: "Source used to produce the stored summary or extraction.",
				sourceType: "document_source",
			},
			text,
			citations: [],
		},
	];
}

function collectAnalysisSources(value: Record<string, unknown>): SourceDetail[] {
	const fileSources = recordsField(value, "files");
	if (fileSources.length > 0) {
		const seen = new Set<string>();
		return fileSources.map((file, index) => ({
			note: {
				id: stableSourceId(undefined, index, seen),
				title: stringField(file, "path") ?? stringField(file, "relativePath"),
				excerpt: stringField(file, "mimeType"),
				relevance: "File analyzed for the stored result.",
				sourceType: "file",
			},
			text: stringField(value, "text") ?? "",
			citations: [],
		}));
	}
	const image = recordField(value, "image");
	if (!image) return [];
	return [
		{
			note: {
				id: "s1",
				title: stringField(image, "path") ?? stringField(image, "imagePath"),
				excerpt: stringField(image, "mimeType"),
				relevance: "Image analyzed for the stored result.",
				sourceType: "image",
			},
			text: stringField(value, "text") ?? stringField(value, "caption") ?? "",
			citations: [],
		},
	];
}

function confidenceFor(
	kind: StoredResultKind,
	sourceCount: number,
	findingCount: number,
	failureCount: number,
): QualitySignals["confidence"] {
	if (failureCount > 0) return "low";
	if (kind === "research") return sourceCount > 0 && findingCount > 0 ? "medium" : "low";
	if (kind === "search") return sourceCount > 0 ? "medium" : "low";
	return "unknown";
}

function coverageFor(kind: StoredResultKind, sourceCount: number): QualitySignals["coverage"] {
	if (kind === "search") return "top_n_only";
	if (kind === "research") return sourceCount > 0 ? "partial" : "unknown";
	return "unknown";
}

function recordField(
	record: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	if (!record) return undefined;
	const value = record[key];
	return isRecord(value) ? value : undefined;
}

function recordsField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const value = record[key];
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	if (!record) return undefined;
	const value = record[key];
	return isNonEmptyString(value) ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stableSourceId(candidate: string | undefined, index: number, seen: Set<string>): string {
	const preferred = candidate ?? `s${index + 1}`;
	if (!seen.has(preferred)) {
		seen.add(preferred);
		return preferred;
	}
	const fallback = `s${index + 1}`;
	if (!seen.has(fallback)) {
		seen.add(fallback);
		return fallback;
	}
	let suffix = 2;
	while (seen.has(`${fallback}-${suffix}`)) suffix += 1;
	const unique = `${fallback}-${suffix}`;
	seen.add(unique);
	return unique;
}

function excerptFromRecord(record: Record<string, unknown>): string | undefined {
	return stringField(record, "snippet") ?? excerptFromText(stringField(record, "text"));
}

function excerptFromText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return truncateToolText(text.replaceAll(/\s+/gu, " ").trim(), 260);
}

function citationSummary(citation: Record<string, unknown>): string | undefined {
	const marker = stringField(citation, "marker");
	const text = stringField(citation, "text");
	const url = stringField(citation, "url");
	return (
		[marker, text ? truncateToolText(text, 180) : url].filter(Boolean).join(" — ") || undefined
	);
}

function searchFinding(result: Record<string, unknown>): string | undefined {
	const title = stringField(result, "title") ?? stringField(result, "url");
	if (!title) return undefined;
	const snippet = stringField(result, "snippet");
	return truncateToolText(snippet ? `${title}: ${snippet}` : title, 260);
}

function textFindings(text: string | undefined): string[] {
	if (!text) return [];
	return text
		.split(/\n+/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, FINDING_LIMIT)
		.map((line) => truncateToolText(line, 260));
}

function textSummary(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return truncateToolText(text.replaceAll(/\s+/gu, " ").trim(), 360);
}

function partialFailuresFromValue(value: unknown): string[] {
	if (!isRecord(value)) return [];
	const failures: string[] = [];
	const error = recordField(value, "error");
	const errorMessage = stringField(error, "message");
	if (errorMessage) failures.push(errorMessage);
	const cacheWarning = stringField(recordField(value, "cacheStatus"), "warning");
	if (cacheWarning) failures.push(cacheWarning);
	return failures;
}

function hasRetrievedAt(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return recordsField(value, "sources").some((source) =>
		Boolean(stringField(source, "retrievedAt")),
	);
}

function topLevelKeys(value: unknown): string[] {
	return isRecord(value) ? Object.keys(value) : [];
}
