export interface PiTextContent {
	type: "text";
	text: string;
}

export interface PiToolShell<TDetails = unknown> {
	content: PiTextContent[];
	details: TDetails;
}

export interface TimingInfo {
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
}

export interface StructuredError {
	code: string;
	phase?: string;
	message: string;
	retryable: boolean;
	provider?: string;
	cause?: unknown;
}

export interface ResultEnvelope<TData = unknown> {
	status?: number | string;
	timing: TimingInfo;
	truncated?: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
	data: TData;
}

export interface SearchProviderMetadata {
	provider: string;
	kind: "gemini-acp" | "local" | "custom";
	requiresCloud: boolean;
	requiresApiKey: boolean;
	requiresLocalAuth?: boolean;
	raw?: unknown;
}

export interface SearchResultItem {
	title: string;
	url: string;
	normalizedUrl: string;
	snippet?: string;
	ranking: number;
	source: SearchProviderMetadata;
}

export interface ResearchSource {
	id: string;
	title?: string;
	url: string;
	normalizedUrl: string;
	snippet?: string;
	text?: string;
	provider?: string;
	hydrated?: boolean;
}

export interface ResearchResult {
	query: string;
	summary: string;
	mode: "local" | "gemini-acp";
	sources: ResearchSource[];
	findings: Array<{ sourceId: string; text: string }>;
	citations: Array<{ sourceId: string; url: string; text?: string }>;
	responseId?: string;
	error?: StructuredError;
}

export interface GeminiAcpPermissionPolicy {
	mode?: "restrictive" | "file-read" | "file-read-write" | "terminal";
	reason?: string;
	updatedAt?: string;
}

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
	permissionPolicy?: GeminiAcpPermissionPolicy;
}

export interface GeminiAcpConfig {
	providers?: {
		"gemini-acp"?: GeminiAcpProviderSettings;
	};
}
