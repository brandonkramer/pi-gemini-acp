/**
 * @fileoverview pi:model-adapter protocol types. Mirrors pi-scraper's internal
 * ModelAdapter / ModelRequest / ModelResponse shape. Keep in sync via README
 * cross-reference.
 */

export type ModelCapability = "summarize" | "extract" | "analyze" | "chat";

export interface ModelRequest {
	task: "extract" | "summarize";
	input: string;
	prompt?: string;
	schema?: unknown;
	options?: Record<string, unknown>;
}

export interface ModelResponse<T = unknown> {
	data: T;
	text?: string;
	raw?: unknown;
}

export interface ModelAdapter {
	run<T = unknown>(
		request: ModelRequest,
		signal?: AbortSignal,
	): Promise<ModelResponse<T>>;
}

export interface RegisteredAdapter {
	id: string;
	label: string;
	capabilities: ModelCapability[];
	priority: number;
	adapter: ModelAdapter;
}

/** Filter sent by pi-scraper on pi:model-adapter/discover to narrow re-registration. */
export interface DiscoverPayload {
	filter?: {
		capabilities?: ModelCapability[];
		minPriority?: number;
	};
}
