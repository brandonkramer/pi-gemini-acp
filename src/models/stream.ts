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
import { estimateCostChars } from "../tools/cost-estimate.ts";
import type { GeminiAcpChatSettings } from "../types.ts";
import { createPreambleBuilder, type PiToolsSource } from "./preamble.ts";
import type { GeminiAcpStreamSimple } from "./types.ts";

// Pi's Api type is KnownApi | (string & {}); it accepts any string routing key.
// We use "gemini-acp" as a custom provider identifier, matching pi-claude-bridge's pattern.
const GEMINI_ACP_API: Api = "gemini-acp";

/** Builds a single ACP prompt request from Pi's multi-turn Context. */
function buildAcpPromptRequest(
	context: Context,
	preamble?: string,
	maxHistoryMessages?: number,
): { parts: GeminiAcpPromptPart[] } {
	const parts: GeminiAcpPromptPart[] = [];
	if (preamble) {
		parts.push({ type: "text", text: preamble });
	} else if (context.systemPrompt) {
		parts.push({ type: "text", text: context.systemPrompt });
	}
	const messages =
		maxHistoryMessages !== undefined && maxHistoryMessages >= 0
			? context.messages.slice(-maxHistoryMessages)
			: context.messages;
	for (const msg of messages) {
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
function extractText(content: unknown): string {
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

/** Estimates Usage from character counts and model id (avoids string allocation). */
function estimateUsage(
	inputChars: number,
	outputChars: number,
	modelId: string,
): AssistantMessage["usage"] {
	const est = estimateCostChars(inputChars, outputChars, { model: modelId });
	return {
		input: est.inputTokens,
		output: est.outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: est.totalTokens,
		cost: {
			input: est.inputCostUsd,
			output: est.outputCostUsd,
			cacheRead: 0,
			cacheWrite: 0,
			total: est.costUsd,
		},
	};
}

/** Extracts cwd from Pi's runtime options. Falls back to process.cwd() when absent. */
function resolveCwd(options: unknown): string {
	if (typeof options !== "object" || options === null) return process.cwd();
	const cwd = (options as Record<string, unknown>).cwd;
	// When Pi starts from ~, AGENTS.md resolution silently misses; walking up is out of scope.
	return typeof cwd === "string" ? cwd : process.cwd();
}

/** Factory that returns a Pi-compatible streamSimple function backed by our ACP client. */
export function createGeminiAcpStreamSimple(
	client: GeminiAcpClient,
	pi: PiToolsSource,
	chatConfig: GeminiAcpChatSettings,
): GeminiAcpStreamSimple {
	const buildPreamble = createPreambleBuilder({
		appendSystemPrompt: chatConfig.appendSystemPrompt !== false,
		appendAgents: chatConfig.appendAgents !== false,
		appendTools: chatConfig.appendTools !== false,
		pi,
	});

	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const partial = createPartialMessage(model);
		stream.push({ type: "start", partial });
		let accumulatedOutput = "";

		void (async () => {
			try {
				const preamble = await buildPreamble({
					modelId: model.id,
					cwd: resolveCwd(options),
					upstreamSystemPrompt: context.systemPrompt,
				});

				const request = buildAcpPromptRequest(context, preamble, chatConfig.maxHistoryMessages);
				const inputChars = request.parts.reduce(
					(sum, p) => sum + (p.type === "text" ? p.text.length : 0),
					0,
				);

				const onUpdate: GeminiAcpPromptUpdateHandler = (chunk) => {
					accumulatedOutput = chunk.accumulatedText;
					// Fresh text object per chunk — Pi may retain partial references, so mutation of
					// a shared block would corrupt historical chunk contents.
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

				const result = await client.prompt(request, options?.signal, onUpdate);

				const final: AssistantMessage = {
					...partial,
					content: [{ type: "text", text: result }],
					usage: estimateUsage(inputChars, result.length, model.id),
					// ACP prompt result is a plain string; the underlying stop reason (max_tokens,
					// safety, etc.) is not surfaced by the current JSON-RPC protocol. If Gemini adds
					// finishReason to the prompt response, map it here instead of hardcoding "stop".
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
