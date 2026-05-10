/**
 * @fileoverview Gemini-backed ModelAdapter exposing summarize capability to
 * pi-scraper via the pi:model-adapter protocol.
 *
 * Delegates to the existing {@link runSummarize} route so the adapter
 * inherits source truncation, API-key fallback, response caching, and
 * cost-estimate plumbing.
 */
import {
	runSummarize,
	type SummarizeDeps,
	type SummarizeOptions,
	type SummarizeRunResult,
	type SummaryStyle,
} from "../prompt/summarize.js";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import type { GeminiAcpConfig } from "../types.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./types.js";

export interface SummarizeAdapterDeps {
	loadConfig?(): Promise<GeminiAcpConfig>;
	runSummarize?(
		options: SummarizeOptions,
		deps?: SummarizeDeps,
		signal?: AbortSignal,
	): Promise<SummarizeRunResult>;
}

export function createGeminiSummarizeAdapter(
	deps?: SummarizeAdapterDeps,
): ModelAdapter {
	const load = deps?.loadConfig ?? defaultLoadConfig;
	const run = deps?.runSummarize ?? runSummarize;

	return {
		async run<T>(
			request: ModelRequest,
			signal?: AbortSignal,
		): Promise<ModelResponse<T>> {
			if (request.task !== "summarize") {
				throw new Error(
					`gemini-acp adapter does not support task "${request.task}" (only summarize)`,
				);
			}
			const config = withDefaultGeminiAcpConfig(configFromEnv(await load()));
			const options = mapRequestToSummarizeOptions(request, config);
			const result = await run(options, {}, signal);
			if (result.error) {
				throw new Error(result.error.message);
			}
			// raw is provider-specific (SummarizeRunResult); consumers should not
			// depend on field names since they may change with internal refactors.
			return {
				data: { summary: result.summary } as unknown as T,
				text: result.summary,
				raw: result,
			};
		},
	};
}

function mapRequestToSummarizeOptions(
	request: ModelRequest,
	config: GeminiAcpConfig,
): SummarizeOptions {
	const opts = request.options ?? {};
	// request.schema is ignored — structured summary extraction is not
	// supported by this adapter. request.options.url is ignored because
	// pi-scraper callers pass already-fetched content in request.input.
	return {
		content: request.input,
		prompt: request.prompt,
		style: validSummaryStyle(opts.style),
		sentenceCount: validFiniteNumber(opts.sentenceCount),
		bulletCount: validFiniteNumber(opts.bulletCount),
		audience: validString(opts.audience),
		title: validString(opts.title),
		maxSourceCharacters: validFiniteNumber(opts.maxSourceCharacters),
		config,
	};
}

function validSummaryStyle(value: unknown): SummaryStyle | undefined {
	if (
		typeof value === "string" &&
		(value === "paragraph" || value === "bullets" || value === "executive")
	) {
		return value;
	}
	return undefined;
}

function validFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function validString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	return undefined;
}

async function defaultLoadConfig(): Promise<GeminiAcpConfig> {
	return configFromEnv(await loadConfig());
}
