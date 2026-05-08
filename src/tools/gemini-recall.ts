import { type Static, Type } from "@mariozechner/pi-ai";
import {
	runRecall,
	type RecallHit,
	type RecallResult,
} from "../recall/recall.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiTool } from "./define.js";
import {
	boxedToolText,
	dimToolText,
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpRecallSchema = Type.Object({
	query: Type.String({ description: "Natural-language recall query." }),
	k: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Maximum prior Gemini results to return.",
		}),
	),
	minScore: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1,
			description: "Minimum FTS recall similarity threshold. Defaults to 0.55.",
		}),
	),
	since: Type.Optional(
		Type.String({
			description: "Only return entries newer than this ISO time.",
		}),
	),
	tool: Type.Optional(
		Type.Union([
			Type.String({ description: "Filter to one Gemini tool name." }),
			Type.Array(Type.String(), {
				description: "Filter to one or more Gemini tool names.",
			}),
		]),
	),
	bypassCache: Type.Optional(
		Type.Boolean({
			description: "No effect while recall uses only local FTS.",
		}),
	),
});

type Params = Static<typeof geminiAcpRecallSchema>;

const RECALL_TITLE_STATE_KEY = "geminiRecallTitle";

export const geminiAcpRecallTool = defineGeminiTool({
	name: "gemini_recall",
	label: "Gemini Recall",
	description: "Search local FTS recall over prior cached Gemini results.",
	parameters: geminiAcpRecallSchema,
	async execute(_toolCallId, params: Params, signal) {
		const result = await runRecall({ ...params, signal });
		if ("error" in result) return errorResult(result.error);
		return toolResult({ text: formatRecallToolText(result), data: result });
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_recall",
			stateKey: RECALL_TITLE_STATE_KEY,
		});
	},
	renderResult(result, _options, theme) {
		return boxedToolText(dimToolText(formatRecallToolDisplay(result), theme));
	},
});

/** Formats a local recall result for assistant-facing tool output. */
export function formatRecallToolText(result: RecallResult): string {
	const top = result.hits[0];
	const lines = [
		`[recall: ${result.hits.length} prior hit(s)${top ? `, top similarity ${top.similarity.toFixed(2)}` : ""}]`,
		`Gemini recall found ${result.hits.length} prior result(s).`,
		`query: ${result.query}`,
		`recallProvider: ${result.recallProvider}`,
		`totalCandidates: ${result.totalCandidates}`,
	];
	if (result.hits.length === 0) {
		lines.push("No prior Gemini results met the recall threshold.");
		return lines.join("\n");
	}
	lines.push("", "Hits:");
	for (const [index, hit] of result.hits.entries()) {
		lines.push(
			`${index + 1}. ${hit.tool} — similarity ${hit.similarity.toFixed(2)} (${similarityBand(hit.similarity)})${hit.matchType ? `, ${hit.matchType}` : ""}`,
			`responseId: ${hit.responseId}`,
			`createdAt: ${hit.createdAt}`,
			`model: ${hit.model}`,
			`summary: ${truncateToolText(hit.summary, 500)}`,
		);
		if (hit.inputsSummary)
			lines.push(`inputs: ${truncateToolText(hit.inputsSummary, 240)}`);
	}
	return lines.join("\n");
}

function formatRecallToolDisplay(result: PiToolShell): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isRecallResult(details.data)) {
		const top = details.data.hits[0];
		return top
			? `gemini_recall: ${details.data.hits.length} ${details.data.recallProvider} hit(s), top ${top.similarity.toFixed(2)} (${top.tool}, ${top.responseId})`
			: `gemini_recall: no prior ${details.data.recallProvider} hits`;
	}
	return result.content[0]?.text ?? details.error?.message ?? "gemini_recall";
}

function isRecallResult(value: unknown): value is RecallResult {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { hits?: unknown }).hits) &&
		typeof (value as { query?: unknown }).query === "string"
	);
}

function similarityBand(similarity: number): "strong" | "moderate" | "weak" {
	if (similarity >= 0.9) return "strong";
	if (similarity >= 0.75) return "moderate";
	return "weak";
}

export type { RecallHit };
