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
} from "@earendil-works/pi-ai";

import { executeWithAccountPool } from "../acp/account-pool-singleton.ts";
import { getCachedGeminiAcpClient } from "../acp/client-cache.ts";
import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpConversation,
	GeminiAcpPromptOutcome,
	GeminiAcpPromptPart,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpPromptUsage,
} from "../acp/client.ts";
import { withGitIdentityForCwd } from "../acp/settings.ts";
import { estimateCostChars, estimateCostTokens } from "../tools/cost-estimate.ts";
import type {
	GeminiAcpChatSettings,
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
} from "../types.ts";
import { createActivityRenderer } from "./activity.ts";
import { buildConversation } from "./conversation.ts";
import { fitHistory, maxHistoryChars } from "./history-budget.ts";
import { AssistantMessageBuilder } from "./message-builder.ts";
import { createPreambleBuilder, type PiToolsSource } from "./preamble.ts";
import { createToolActivityLog } from "./tool-activity.ts";
import { conversationMessages, currentSystemPrompt, messageToText } from "./transcript.ts";
import type { GeminiAcpStreamSimple } from "./types.ts";

// Pi's Api type is KnownApi | (string & {}); it accepts any string routing key.
// We use "gemini-acp" as a custom provider identifier, matching pi-claude-bridge's pattern.
const GEMINI_ACP_API: Api = "gemini-acp";

/**
 * Builds the ACP prompt request for one chat turn. `parts` holds the full flattened history for a
 * fresh Gemini session; `conversation` lets the cached client continue the session that already
 * holds the earlier messages and send only the new ones.
 */
function buildAcpPromptRequest(
	context: Context,
	modelId: string,
	preamble: string | undefined,
	chatConfig: Pick<GeminiAcpChatSettings, "maxHistoryMessages" | "maxHistoryChars">,
): { parts: GeminiAcpPromptPart[]; conversation: GeminiAcpConversation } {
	const { maxHistoryMessages } = chatConfig;
	const parts: GeminiAcpPromptPart[] = [];
	// An empty preamble (every section disabled) falls back to Pi's own system prompt.
	const systemPrompt =
		(preamble !== undefined && preamble.length > 0 ? preamble : currentSystemPrompt(context)) ?? "";
	if (systemPrompt) parts.push({ type: "text", text: systemPrompt });
	const conversation = conversationMessages(context);
	const messages =
		maxHistoryMessages !== undefined && maxHistoryMessages >= 0
			? conversation.slice(-Math.max(1, Math.floor(maxHistoryMessages)))
			: conversation;
	// The budget covers the whole prompt, so the preamble/system prompt is taken out of it first.
	const history = fitHistory(
		messages.map((message) => ({ role: message.role, text: messageToText(message) })),
		Math.max(0, maxHistoryChars(chatConfig.maxHistoryChars) - systemPrompt.length),
	);
	for (const text of history) parts.push({ type: "text", text });
	return {
		parts,
		conversation: buildConversation(conversation, `${modelId}\0${systemPrompt}`),
	};
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

/** Usage from the token counts Gemini CLI reports, priced per model that served the turn. */
function reportedUsage(usage: GeminiAcpPromptUsage, modelId: string): AssistantMessage["usage"] {
	const perModel =
		usage.models.length > 0
			? usage.models
			: [{ model: modelId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }];
	const costs = perModel.map((entry) =>
		estimateCostTokens(entry.inputTokens, entry.outputTokens, { model: entry.model }),
	);
	const input = costs.reduce((sum, cost) => sum + cost.inputCostUsd, 0);
	const output = costs.reduce((sum, cost) => sum + cost.outputCostUsd, 0);
	return {
		input: usage.inputTokens,
		output: usage.outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: usage.inputTokens + usage.outputTokens,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

/** Maps the ACP stop reason to Pi's. An error message is returned for turns that did not finish. */
function piStopReason(stopReason: string | undefined): {
	reason: "stop" | "length";
	errorMessage?: string;
} {
	if (stopReason === "max_tokens" || stopReason === "max_turn_requests")
		return { reason: "length" };
	if (stopReason === "refusal") {
		return { reason: "stop", errorMessage: "Gemini refused to continue this request." };
	}
	if (stopReason === "cancelled") {
		return { reason: "stop", errorMessage: "Gemini ACP cancelled the turn." };
	}
	return { reason: "stop" };
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
		const toolLog = createToolActivityLog();

		void (async () => {
			try {
				const preamble = await buildPreamble({
					modelId: model.id,
					cwd: resolveCwd(options),
					upstreamSystemPrompt: currentSystemPrompt(context),
				});

				const built = {
					...buildAcpPromptRequest(context, model.id, preamble, chatConfig),
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
				let outcome: GeminiAcpPromptOutcome = {};
				const observers = {
					onActivity: createActivityRenderer(message, toolLog),
					onOutcome: (reported: GeminiAcpPromptOutcome) => {
						outcome = reported;
					},
				};

				const effectiveSettings = promptSettingsForModel(settings, model.id);

				const result = await executeWithAccountPool(
					config,
					effectiveSettings,
					async (accountSettings: GeminiAcpCommandSettings) => {
						const commandSettings = withGitIdentityForCwd(accountSettings, request.cwd);
						const client: GeminiAcpClient = clientFactory
							? clientFactory(commandSettings)
							: getCachedGeminiAcpClient(commandSettings, "prompt");
						return await client.prompt(request, options?.signal, onUpdate, observers);
					},
					options?.signal,
					rootDir,
				);
				// Clients that return the answer without streaming it still produce a text block.
				if (!message.text() && result) message.appendText(result);
				toolLog?.finish();

				const stop = piStopReason(outcome.stopReason);
				if (stop.errorMessage) throw new Error(stop.errorMessage);
				const final: AssistantMessage = {
					...partial,
					content: message.finish(),
					usage: outcome.usage
						? reportedUsage(outcome.usage, model.id)
						: estimateUsage(inputChars, result.length, model.id),
					stopReason: stop.reason,
					timestamp: Date.now(),
				};

				stream.push({ type: "done", reason: stop.reason, message: final });
				stream.end();
			} catch (cause) {
				toolLog?.finish();
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
