/** @file Agent-facing stored-result view contracts for progressive disclosure. */

export type StoredResultKind = "research" | "search" | "ask" | "analysis" | "unknown";

export type StoredResultView = "overview" | "source" | "raw";

export interface SourceNote {
	id: string;
	title?: string;
	uri?: string;
	excerpt?: string;
	relevance?: string;
	retrievedAt?: string;
	sourceType?: string;
}

export interface QualitySignals {
	confidence: "high" | "medium" | "low" | "unknown";
	coverage: "complete" | "partial" | "sampled" | "top_n_only" | "unknown";
	freshness: "current" | "stale_possible" | "unknown";
	knownGaps: string[];
	conflicts: string[];
	partialFailures: string[];
}

export interface ResultPagination {
	nextCursor?: string;
	hasMore: boolean;
}

export interface NextAction {
	action: "inspect_source" | "get_page" | "raw";
	description: string;
	params: Record<string, unknown>;
}

export interface StoredResultDiagnostics {
	responseId: string;
	fullOutputPath?: string;
	originalTopLevelKeys: string[];
}

export interface StoredResultOverviewData {
	view: "overview";
	resultId: string;
	kind: StoredResultKind;
	query?: string;
	summary: string;
	answerContext: string;
	sourceNotes: SourceNote[];
	qualitySignals: QualitySignals;
	pagination?: ResultPagination;
	nextActions: NextAction[];
	assistantGuidance: string;
	diagnostics: StoredResultDiagnostics;
}

export interface StoredResultSourceData {
	view: "source";
	resultId: string;
	kind: StoredResultKind;
	source: SourceNote & { citations: string[] };
	sourceText: string;
	pagination: ResultPagination & { start: number; end: number };
	nextActions: NextAction[];
	assistantGuidance: string;
	diagnostics: StoredResultDiagnostics;
}

export interface StoredResultRawData {
	view: "raw";
	resultId: string;
	kind: StoredResultKind;
	rawFormat: "json";
	rawText: string;
	pagination: ResultPagination & { start: number; end: number };
	nextActions: NextAction[];
	assistantGuidance: string;
	diagnostics: StoredResultDiagnostics;
}

export type StoredResultGetData =
	| StoredResultOverviewData
	| StoredResultSourceData
	| StoredResultRawData;
