/**
 * @file StreamSimple adapter: bridges ACP JSON-RPC prompt streaming to Pi
 *   AssistantMessageEventStream.
 */
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";

import type {
	GeminiAcpClient,
	GeminiAcpPromptPart,
	GeminiAcpPromptUpdateHandler,
} from "../acp/client.ts";
import { estimateCost } from "../tools/cost-estimate.ts";
import type { GeminiAcpStreamSimple } from "./types.ts";

// Pi's Api type is KnownApi | (string & {}); it accepts any string routing key.
// We use "gemini-acp" as a custom provider identifier, matching pi-claude-bridge's pattern.
const GEMINI_ACP_API: Api = "gemini-acp";

/** Builds a single ACP prompt request from Pi's multi-turn Context. */
function buildAcpPromptRequest(context: Context): { parts: GeminiAcpPromptPart[] } {
	const parts: GeminiAcpPromptPart[] = [];
	if (context.systemPrompt) {
		parts.push({ type: "text", text: context.systemPrompt });
	}
	for (const msg of context.messages) {
		const text = messageToText(msg);
		if (text) parts.push({ type: "text", text });
	}
	return { parts };
}

/** Flattens one Pi Message into a text fragment for the ACP prompt. */
function messageToText(msg: Message): string | undefined {
	if (msg.role === "user") {
		const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
		return `User: ${text}`;
	}
	if (msg.role === "assistant") {
		return `Assistant: ${extractText(msg.content)}`;
	}
	// Remaining Message union member is toolResult; TypeScript narrows here.
	return `Tool (${msg.toolName}): ${extractText(msg.content)}`;
}

/** Extracts plain text from Pi content blocks. */
function extractText(content: unknown[]): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextContent => {
			if (typeof c !== "object" || c === null) return false;
			const obj = c as Record<string, unknown>;
			return obj.type === "text" && typeof obj.text === "string";
		})
		.map((c) => c.text)
		.join("");
}

/** Creates a fresh partial AssistantMessage skeleton. */
function createPartialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: GEMINI_ACP_API,
		provider: "gemini-acp",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Estimates Usage from input/output text and model id. */
function estimateUsage(
	inputText: string,
	outputText: string,
	modelId: string,
): AssistantMessage["usage"] {
	const est = estimateCost(inputText, outputText, { model: modelId });
	return {
		input: est.inputTokens,
		output: est.outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: est.totalTokens,
		cost: {
			input: est.costUsd * (est.inputTokens / est.totalTokens || 0),
			output: est.costUsd * (est.outputTokens / est.totalTokens || 0),
			cacheRead: 0,
			cacheWrite: 0,
			total: est.costUsd,
		},
	};
}

/** Factory that returns a Pi-compatible streamSimple function backed by our ACP client. */
export function createGeminiAcpStreamSimple(client: GeminiAcpClient): GeminiAcpStreamSimple {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const partial = createPartialMessage(model);
		let accumulatedOutput = "";

		void (async () => {
			try {
				stream.push({ type: "start", partial });

				const request = buildAcpPromptRequest(context);
				const inputText = request.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");

				const onUpdate: GeminiAcpPromptUpdateHandler = (chunk) => {
					accumulatedOutput = chunk.accumulatedText;
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: chunk.text,
						partial: {
							...partial,
							content: [{ type: "text", text: accumulatedOutput }],
						},
					});
				};

				const result = await client.prompt({ ...request, prompt: "" }, options?.signal, onUpdate);

				const final: AssistantMessage = {
					...partial,
					content: [{ type: "text", text: result }],
					usage: estimateUsage(inputText, result, model.id),
					stopReason: "stop",
					timestamp: Date.now(),
				};

				stream.push({ type: "done", reason: "stop", message: final });
				stream.end();
			} catch (cause) {
				const errorMessage = cause instanceof Error ? cause.message : String(cause);
				const aborted = options?.signal?.aborted ?? false;
				const final: AssistantMessage = {
					...partial,
					content: [{ type: "text", text: accumulatedOutput }],
					stopReason: aborted ? "aborted" : "error",
					errorMessage,
					timestamp: Date.now(),
				};
				stream.push({
					type: "error",
					reason: final.stopReason as "error" | "aborted",
					error: final,
				});
				stream.end();
			}
		})();

		return stream;
	};
}
