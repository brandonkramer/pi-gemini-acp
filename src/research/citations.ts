import { coerceFiniteNumber, coerceString } from "../coerce.js";
import type { ResearchProviderSourceMetadata } from "../types.js";

export interface NormalizedGroundingSupport {
	startByte?: number;
	endByte?: number;
	text?: string;
	sourceIndexes: number[];
}

export interface NormalizedResearchProviderMetadata {
	groundingChunks: ResearchProviderSourceMetadata[];
	groundingSupports: NormalizedGroundingSupport[];
	retrievedUrls: ResearchProviderSourceMetadata[];
	raw?: unknown;
}

export interface InsertedProviderCitation {
	marker: string;
	startByte?: number;
	endByte?: number;
	text?: string;
	providerSources: ResearchProviderSourceMetadata[];
}

export interface CitationInsertionResult {
	text: string;
	citations: InsertedProviderCitation[];
}

/** Converts Gemini-style grounding and URL metadata into one defensive shape. */
export function normalizeResearchProviderMetadata(
	raw: unknown,
): NormalizedResearchProviderMetadata {
	const record = asRecord(raw);
	const grounding = record
		? (recordValue(record, "groundingMetadata", "grounding_metadata") ?? record)
		: undefined;
	const urlContext = record
		? (recordValue(record, "urlContextMetadata", "url_context_metadata") ??
			recordValue(record, "url_context", "urlContext"))
		: undefined;
	const retrievedUrls = normalizeRetrievedUrls(urlContext ?? record);
	const groundingChunks = normalizeGroundingChunks(grounding, retrievedUrls);
	return {
		groundingChunks,
		groundingSupports: normalizeGroundingSupports(grounding),
		retrievedUrls,
		raw,
	};
}

/** Returns true when normalized provider metadata contains citation inputs. */
export function hasResearchProviderMetadata(metadata: NormalizedResearchProviderMetadata): boolean {
	return (
		metadata.groundingChunks.length > 0 ||
		metadata.groundingSupports.length > 0 ||
		metadata.retrievedUrls.length > 0
	);
}

/** Inserts provider citation markers at UTF-8 byte offsets without splitting text. */
export function insertProviderCitationMarkers(
	text: string,
	metadata: NormalizedResearchProviderMetadata,
): CitationInsertionResult {
	const insertions = new Map<number, string[]>();
	const citations: InsertedProviderCitation[] = [];
	metadata.groundingSupports.forEach((support, index) => {
		const endByte = support.endByte;
		if (endByte === undefined) return;
		const sourceIndexes = support.sourceIndexes.length > 0 ? support.sourceIndexes : [index];
		const marker = `[${sourceIndexes.map((value) => value + 1).join(",")}]`;
		const insertionIndex = stringIndexAtUtf8Byte(text, endByte, "end");
		const markers = insertions.get(insertionIndex) ?? [];
		markers.push(marker);
		insertions.set(insertionIndex, markers);
		citations.push({
			marker,
			startByte: support.startByte,
			endByte: support.endByte,
			text: support.text,
			providerSources: sourceIndexes.flatMap((sourceIndex) =>
				metadata.groundingChunks[sourceIndex] ? [metadata.groundingChunks[sourceIndex]] : [],
			),
		});
	});
	let citedText = text;
	for (const [index, markers] of [...insertions.entries()].toSorted(
		([left], [right]) => right - left,
	)) {
		citedText = `${citedText.slice(0, index)}${markers.join("")}${citedText.slice(index)}`;
	}
	return { text: citedText, citations };
}

function normalizeGroundingChunks(
	grounding: unknown,
	retrievedUrls: ResearchProviderSourceMetadata[],
): ResearchProviderSourceMetadata[] {
	const record = asRecord(grounding);
	const chunks = arrayValue(record && recordValue(record, "groundingChunks", "grounding_chunks"));
	return chunks.map((chunk, index) => {
		const chunkRecord = asRecord(chunk);
		const web = chunkRecord
			? (recordValue(chunkRecord, "web") ??
				recordValue(chunkRecord, "retrievedContext", "retrieved_context"))
			: undefined;
		const webRecord = asRecord(web);
		const url = coerceString(
			firstDefined(
				webRecord && recordValue(webRecord, "uri", "url"),
				chunkRecord && recordValue(chunkRecord, "uri", "url"),
				chunkRecord && recordValue(chunkRecord, "retrievedUrl", "retrieved_url"),
			),
		);
		const matched = url ? retrievedUrls.find((candidate) => candidate.url === url) : undefined;
		return {
			index,
			url,
			title: coerceString(
				firstDefined(
					webRecord && recordValue(webRecord, "title"),
					chunkRecord && recordValue(chunkRecord, "title"),
					matched?.title,
				),
			),
			retrievalStatus:
				coerceString(
					firstDefined(
						chunkRecord && recordValue(chunkRecord, "retrievalStatus", "retrieval_status"),
						matched?.retrievalStatus,
					),
				) ?? matched?.retrievalStatus,
		};
	});
}

function normalizeGroundingSupports(grounding: unknown): NormalizedGroundingSupport[] {
	const record = asRecord(grounding);
	const supports = arrayValue(
		record && recordValue(record, "groundingSupports", "grounding_supports"),
	);
	return supports.map((support) => {
		const supportRecord = asRecord(support);
		const segment = supportRecord ? asRecord(recordValue(supportRecord, "segment")) : undefined;
		return {
			startByte: coerceFiniteNumber(
				firstDefined(
					segment && recordValue(segment, "startIndex", "start_index"),
					supportRecord && recordValue(supportRecord, "startByte", "start_byte"),
					supportRecord && recordValue(supportRecord, "startIndex", "start_index"),
				),
			),
			endByte: coerceFiniteNumber(
				firstDefined(
					segment && recordValue(segment, "endIndex", "end_index"),
					supportRecord && recordValue(supportRecord, "endByte", "end_byte"),
					supportRecord && recordValue(supportRecord, "endIndex", "end_index"),
				),
			),
			text: coerceString(segment && recordValue(segment, "text")),
			sourceIndexes: numberArray(
				supportRecord &&
					recordValue(supportRecord, "groundingChunkIndices", "grounding_chunk_indices"),
			),
		};
	});
}

function normalizeRetrievedUrls(raw: unknown): ResearchProviderSourceMetadata[] {
	const record = asRecord(raw);
	const entries = arrayValue(
		record &&
			firstDefined(
				recordValue(record, "urlMetadata", "url_metadata"),
				recordValue(record, "retrievedUrls", "retrieved_urls"),
			),
	);
	return entries.flatMap((entry, index) => {
		if (typeof entry === "string") return [{ index, url: entry }];
		const entryRecord = asRecord(entry);
		const url = coerceString(
			entryRecord &&
				firstDefined(
					recordValue(entryRecord, "retrievedUrl", "retrieved_url"),
					recordValue(entryRecord, "url", "uri"),
				),
		);
		if (!url) return [];
		return [
			{
				index,
				url,
				title: coerceString(entryRecord && recordValue(entryRecord, "title")),
				retrievalStatus: coerceString(
					entryRecord &&
						firstDefined(
							recordValue(entryRecord, "retrievalStatus", "retrieval_status"),
							recordValue(entryRecord, "urlRetrievalStatus", "url_retrieval_status"),
						),
				),
			},
		];
	});
}

function stringIndexAtUtf8Byte(text: string, byteOffset: number, mode: "start" | "end"): number {
	const buffer = Buffer.from(text, "utf8");
	let offset = Math.max(0, Math.min(buffer.length, Math.trunc(byteOffset)));
	while (offset > 0 && offset < buffer.length && isContinuationByte(buffer[offset])) {
		offset += mode === "end" ? 1 : -1;
	}
	return buffer.subarray(0, offset).toString("utf8").length;
}

function recordValue(record: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (record[key] !== undefined) return record[key];
	}
	return undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function firstDefined(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined);
}

function numberArray(value: unknown): number[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is number =>
					typeof entry === "number" && Number.isInteger(entry) && entry >= 0,
			)
		: [];
}

function isContinuationByte(value: number | undefined): boolean {
	return value !== undefined && (value & 0xc0) === 0x80;
}
