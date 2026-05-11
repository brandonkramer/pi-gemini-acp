/** @file Approximate token counting, cost estimation, and title caching for Gemini tool results. */
import { toolResult } from "./result.ts";

/** Rough token/cost estimate for a Gemini tool call. */
export interface CostEstimate {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

const CHARS_PER_TOKEN = 4;

// Verified against ai.google.dev/pricing on 2026-05-11.
// Gemini 2.5 Flash pricing per 1M tokens
const FLASH_INPUT_PER_1M = 0.075;
const FLASH_OUTPUT_PER_1M = 0.3;

// Gemini 2.5 Pro pricing per 1M tokens
const PRO_INPUT_PER_1M = 1.25;
const PRO_OUTPUT_PER_1M = 10.0;

// Gemini 2.5 Flash-Lite pricing per 1M tokens
const FLASH_LITE_INPUT_PER_1M = 0.075;
const FLASH_LITE_OUTPUT_PER_1M = 0.3;

// Search grounding surcharge
const SEARCH_GROUNDING_COST = 0.035;

/** Roughly estimates tokens from plain text length. */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Picks the per-token price based on model name. */
function modelPrices(model?: string): {
	inputPer1M: number;
	outputPer1M: number;
} {
	const m = model?.toLowerCase() ?? "";
	if (m.includes("pro") && !m.includes("flash")) {
		return { inputPer1M: PRO_INPUT_PER_1M, outputPer1M: PRO_OUTPUT_PER_1M };
	}
	if (m.includes("lite") || m.includes("8b")) {
		return {
			inputPer1M: FLASH_LITE_INPUT_PER_1M,
			outputPer1M: FLASH_LITE_OUTPUT_PER_1M,
		};
	}
	return { inputPer1M: FLASH_INPUT_PER_1M, outputPer1M: FLASH_OUTPUT_PER_1M };
}

/** Estimates cost for a Gemini-backed tool call. */
export function estimateCost(
	inputText: string,
	outputText: string,
	options: { model?: string; searchCount?: number } = {},
): CostEstimate {
	const inputTokens = estimateTokens(inputText);
	const outputTokens = estimateTokens(outputText);
	const { inputPer1M, outputPer1M } = modelPrices(options.model);
	const tokenCost = (inputTokens * inputPer1M + outputTokens * outputPer1M) / 1_000_000;
	const searchCost = (options.searchCount ?? 0) * SEARCH_GROUNDING_COST;
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		costUsd: tokenCost + searchCost,
	};
}

/** Formats a concise cost string for tool titles. */
export function formatCostLabel(estimate: CostEstimate): string {
	const cost = estimate.costUsd < 0.001 ? "<$0.001" : `~$${estimate.costUsd.toFixed(3)}`;
	const k = estimate.totalTokens >= 1000;
	const tokenText = k
		? `~${(estimate.totalTokens / 1000).toFixed(1)}k tokens`
		: `~${estimate.totalTokens} tokens`;
	return `${tokenText} · ${cost}`;
}

/** Builds a tool title that includes the cost estimate. */
export function costToolTitle(toolName: string, estimate: CostEstimate): string {
	return `${toolName} · ${formatCostLabel(estimate)}`;
}

/** Caches cost titles so renderCall can show them after execute completes. */
const toolTitleCache = new Map<string, string>();

/** Stores a tool title for later retrieval by renderCall. */
export function cacheToolTitle(toolCallId: string, title: string): void {
	toolTitleCache.set(toolCallId, title);
}

/** Retrieves a cached tool title without removing it (survives expand/collapse toggles). */
export function getCachedToolTitle(toolCallId: string): string | undefined {
	return toolTitleCache.get(toolCallId);
}

/** Shared helper: estimates cost, builds title, caches it, and returns a PiToolShell. */
export function toolResultWithCost<TData>(
	toolCallId: string,
	toolName: string,
	inputText: string,
	outputText: string,
	options: { model?: string; searchCount?: number },
	result: Omit<Parameters<typeof toolResult<TData>>[0], "title">,
): ReturnType<typeof toolResult<TData>> {
	const cost = estimateCost(inputText, outputText, options);
	const title = costToolTitle(toolName, cost);
	cacheToolTitle(toolCallId, title);
	return toolResult({ ...result, title });
}
