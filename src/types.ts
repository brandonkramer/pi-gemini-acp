/** Text content item returned in Pi tool shells. */
export interface PiTextContent {
	type: "text";
	text: string;
}

/** Standard Pi tool shell shape used by public handlers and progress updates. */
export interface PiToolShell<TDetails = unknown> {
	content: PiTextContent[];
	details: TDetails;
	/** Collapsed title shown by Pi when the tool completes. */
	title?: string;
}

/** Basic timing metadata for stored and inline result envelopes. */
export interface TimingInfo {
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
}

/** Stable structured error shape returned by tool workflows. */
export interface StructuredError {
	code: string;
	phase?: string;
	message: string;
	retryable: boolean;
	provider?: string;
	cause?: unknown;
}

/** Details envelope for Pi tool results and retrievable stored outputs. */
export interface ResultEnvelope<TData = unknown> {
	status?: number | string;
	timing: TimingInfo;
	truncated?: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
	data: TData;
}

/** Provider provenance attached to search results. */
export interface SearchProviderMetadata {
	provider: string;
	kind: "gemini-acp" | "local" | "custom";
	requiresCloud: boolean;
	requiresApiKey: boolean;
	requiresLocalAuth?: boolean;
	raw?: unknown;
}

/** Normalized search result consumed by search and research workflows. */
export interface SearchResultItem {
	title: string;
	url: string;
	normalizedUrl: string;
	snippet?: string;
	ranking: number;
	source: SearchProviderMetadata;
}

/** Provider source metadata referenced by grounded research citation ranges. */
export interface ResearchProviderSourceMetadata {
	index: number;
	url?: string;
	title?: string;
	retrievalStatus?: string;
}

/** Source collected for a research run. */
export interface ResearchSource {
	id: string;
	title?: string;
	url: string;
	normalizedUrl: string;
	snippet?: string;
	text?: string;
	provider?: string;
	hydrated?: boolean;
	providerMetadata?: unknown;
}

/** Extracted or assembled finding linked back to a research source. */
export interface ResearchFinding {
	sourceId: string;
	text: string;
}

/** Citation linked to a source and optional provider grounding metadata. */
export interface ResearchCitation {
	sourceId: string;
	url: string;
	text?: string;
	marker?: string;
	startByte?: number;
	endByte?: number;
	providerSources?: ResearchProviderSourceMetadata[];
}

/** Final research payload stored behind responseId and returned in details.data. */
export interface ResearchResult {
	query: string;
	summary: string;
	mode: "local" | "gemini-acp";
	provider?: "local" | "gemini-acp";
	model?: string;
	sources: ResearchSource[];
	findings: ResearchFinding[];
	citations: ResearchCitation[];
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

/** Persisted permission policy for optional broader Gemini ACP capabilities. */
export interface GeminiAcpPermissionPolicy {
	filesystemRead?: boolean;
	filesystemWrite?: boolean;
	terminal?: boolean;
	reason?: string;
	updatedAt?: string;
}

/** Persisted settings for the local user-provided Gemini ACP provider. */
export interface GeminiAcpProviderSettings {
	enabled?: boolean;
	command?: string;
	args?: string[];
	authenticated?: boolean;
	searchGroundingAvailable?: boolean;
	requiresSearchGrounding?: boolean;
	model?: string;
	modelSelectionAvailable?: boolean;
	modelSelectionCheckedAt?: string;
	fileAnalysisAvailable?: boolean;
	imageInputAvailable?: boolean;
	permissionPolicy?: GeminiAcpPermissionPolicy;
	/** Optional Gemini API key for REST API fallback when ACP is unavailable. */
	apiKey?: string;
}

/** Top-level persisted and environment-derived Gemini ACP configuration. */
export interface GeminiAcpConfig {
	providers?: {
		"gemini-acp"?: GeminiAcpProviderSettings;
	};
	recallEnabled?: boolean;
}
