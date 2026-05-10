/**
 * @fileoverview Gemini-backed ModelAdapter exposing summarize capability to
 * pi-scraper via the pi:model-adapter protocol.
 *
 * Delegates to the existing {@link runSummarize} route so the adapter
 * inherits source truncation, API-key fallback, response caching, and
 * cost-estimate plumbing.
 */
import { coerceEnum, coerceFiniteNumber, coerceString } from "../coerce.js";
import {
	runSummarize,
	type SummarizeDeps,
	type SummarizeOptions,
	type SummarizeRunResult,
	type SummaryStyle,
} from "../prompt/summarize.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./types.js";

const SUMMARY_STYLES: readonly SummaryStyle[] = [
	"paragraph",
	"bullets",
	"executive",
];

export function createGeminiSummarizeAdapter(
	run?: (
		options: SummarizeOptions,
		deps?: SummarizeDeps,
		signal?: AbortSignal,
	) => Promise<SummarizeRunResult>,
): ModelAdapter {
	const executor = run ?? runSummarize;

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
			const options = mapRequestToSummarizeOptions(request);
			const result = await executor(options, {}, signal);
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

function mapRequestToSummarizeOptions(request: ModelRequest): SummarizeOptions {
	const opts = request.options ?? {};
	// request.schema is ignored — structured summary extraction is not
	// supported by this adapter. request.options.url is ignored because
	// pi-scraper callers pass already-fetched content in request.input.
	return {
		content: request.input,
		prompt: request.prompt,
		style: coerceEnum<SummaryStyle>(opts.style, SUMMARY_STYLES),
		sentenceCount: coerceFiniteNumber(opts.sentenceCount),
		bulletCount: coerceFiniteNumber(opts.bulletCount),
		audience: coerceString(opts.audience),
		title: coerceString(opts.title),
		maxSourceCharacters: coerceFiniteNumber(opts.maxSourceCharacters),
	};
}
