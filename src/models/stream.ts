/**
 * @file StreamSimple adapter: bridges ACP JSON-RPC prompt streaming to Pi
 *   AssistantMessageEventStream.
 */
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";

import { executeWithAccountPool } from "../acp/account-pool-singleton.ts";
import { getCachedGeminiAcpClient } from "../acp/client-cache.ts";
import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptPart,
	GeminiAcpPromptUpdateHandler,
} from "../acp/client.ts";
import { estimateCostChars } from "../tools/cost-estimate.ts";
import type {
	GeminiAcpChatSettings,
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
} from "../types.ts";
import { AssistantMessageBuilder } from "./message-builder.ts";
import { createPreambleBuilder, type PiToolsSource } from "./preamble.ts";
import {
	conversationMessages,
	currentSystemPrompt,
	type ConversationMessage,
} from "./transcript.ts";
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
	// An empty preamble (every section disabled) falls back to Pi's own system prompt.
	const systemPrompt =
		preamble !== undefined && preamble.length > 0 ? preamble : currentSystemPrompt(context);
	if (systemPrompt) parts.push({ type: "text", text: systemPrompt });
	const conversation = conversationMessages(context);
	const messages =
		maxHistoryMessages !== undefined && maxHistoryMessages >= 0
			? conversation.slice(-Math.max(1, Math.floor(maxHistoryMessages)))
			: conversation;
	for (const msg of messages) {
		const text = messageToText(msg);
		if (text) parts.push({ type: "text", text });
	}
	return { parts };
}

/** Flattens one Pi Message into a text fragment for the ACP prompt. */
function messageToText(msg: ConversationMessage): string | undefined {
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

/**
 * Provider settings for a chat turn on the Pi-selected `modelId`. The prompt prewarm must use the
 * same function: the cached ACP client is keyed by the resulting command line.
 */
export function promptSettingsForModel(
	settings: GeminiAcpProviderSettings | undefined,
	modelId: string,
): GeminiAcpProviderSettings {
	return { ...settings, model: modelId };
}

/** Factory that returns a Pi-compatible streamSimple function backed by our ACP client. */
export function createGeminiAcpStreamSimple(
	config: GeminiAcpConfig,
	settings: GeminiAcpProviderSettings | undefined,
	pi: PiToolsSource,
	chatConfig: GeminiAcpChatSettings,
	/** Override for tests: replaces executeWithAccountPool + getCachedGeminiAcpClient. */
	clientFactory?: (commandSettings: GeminiAcpCommandSettings) => GeminiAcpClient,
	/** Storage root for the cooldown store; defaults to ~/.pi/gemini-acp. */
	rootDir?: string,
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
		const message = new AssistantMessageBuilder(stream, partial);

		void (async () => {
			try {
				const preamble = await buildPreamble({
					modelId: model.id,
					cwd: resolveCwd(options),
					upstreamSystemPrompt: currentSystemPrompt(context),
				});

				const built = {
					...buildAcpPromptRequest(context, preamble, chatConfig.maxHistoryMessages),
					cwd: resolveCwd(options),
				};
				// Extensions may inspect or replace the request, as with built-in providers.
				const replaced = (await options?.onPayload?.(built, model)) as typeof built | undefined;
				const request = replaced ?? built;
				const inputChars = request.parts.reduce(
					(sum, p) => sum + (p.type === "text" ? p.text.length : 0),
					0,
				);

				const onUpdate: GeminiAcpPromptUpdateHandler = (chunk) => {
					message.appendText(chunk.text);
				};

				const effectiveSettings = promptSettingsForModel(settings, model.id);

				const result = await executeWithAccountPool(
					config,
					effectiveSettings,
					async (commandSettings: GeminiAcpCommandSettings) => {
						const client: GeminiAcpClient = clientFactory
							? clientFactory(commandSettings)
							: getCachedGeminiAcpClient(commandSettings, "prompt");
						return await client.prompt(request, options?.signal, onUpdate);
					},
					options?.signal,
					rootDir,
				);
				// Clients that return the answer without streaming it still produce a text block.
				if (!message.text() && result) message.appendText(result);

				const final: AssistantMessage = {
					...partial,
					content: message.finish(),
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
					content: message.finish(),
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
