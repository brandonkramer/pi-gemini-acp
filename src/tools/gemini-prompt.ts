import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type PromptRunResult,
	type PromptWorkflowUpdate,
	runPrompt,
} from "../prompt/run.js";
import type { PiToolShell } from "../types.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
import {
	appendExpansionHint,
	isRecord,
	renderPromptToolResult,
	resultMetadataLines,
	storedOutputLine,
} from "./gemini-prompt-rendering.js";
import {
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
import { withToolResponseCache } from "./cache.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpPromptSchema = Type.Object({
	prompt: Type.String({
		minLength: 1,
		description: "Plain text prompt to send to the configured Gemini ACP.",
	}),
	useCache: Type.Optional(
		Type.Boolean({ description: "Opt in to persistent response-cache reuse." }),
	),
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response-cache lookup for this call." }),
	),
});

type Params = Static<typeof geminiAcpPromptSchema>;

const PROMPT_TITLE_STATE_KEY = "geminiPromptTitle";

export const geminiAcpPromptTool = defineGeminiTool({
	name: "gemini_prompt",
	label: "Gemini ACP Prompt",
	description:
		"Send a plain text prompt to a configured, authenticated local Gemini ACP command. Requires local ACP setup/auth; no local/no-key fallback is available for arbitrary prompts.",
	parameters: geminiAcpPromptSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
		return withToolResponseCache({
			toolName: "gemini_prompt",
			inputs: params,
			enabledByDefault: false,
			useCache: params.useCache,
			bypassCache: params.bypassCache,
			execute: async () => {
				const result = await runPrompt(
					params,
					{},
					signal,
					promptToolUpdate(onUpdate),
				);
				if (result.error) return errorResult(result.error);
				return toolResult({
					text: result.truncated
						? `Gemini ACP response stored as responseId ${result.responseId}. Preview:\n${result.text}`
						: `Gemini ACP response:\n${result.text}`,
					data: result,
					responseId: result.responseId,
					fullOutputPath: result.fullOutputPath,
				});
			},
		});
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_prompt",
			stateKey: PROMPT_TITLE_STATE_KEY,
		});
	},
	renderResult(result, options, theme) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_prompt",
			isData: isPromptRunResult,
			collapsed: formatPromptCollapsedDisplay,
			expanded: formatPromptExpandedDisplay,
		});
	},
});

function formatPromptCollapsedDisplay(result: PromptRunResult): string {
	const lines = [
		result.truncated
			? `Gemini ACP response stored as responseId ${result.responseId}.`
			: "Gemini ACP response received.",
		`Preview: ${truncateToolText(result.text, 240)}`,
	];
	return appendExpansionHint(
		lines,
		"the full response and storage details",
	).join("\n");
}

function formatPromptExpandedDisplay(
	result: PromptRunResult,
	shell: PiToolShell,
): string {
	const lines = [
		"Gemini ACP response:",
		result.text,
		"",
		`provider: ${result.provider}`,
		`responseLength: ${result.responseLength}`,
		`truncated: ${result.truncated}`,
		...resultMetadataLines(shell),
	];
	const stored = storedOutputLine(result);
	if (stored) lines.push(`storage: ${stored}`);
	return lines.join("\n");
}

function isPromptRunResult(value: unknown): value is PromptRunResult {
	return (
		isRecord(value) &&
		value.provider === "gemini-acp" &&
		typeof value.text === "string" &&
		typeof value.responseLength === "number" &&
		typeof value.truncated === "boolean"
	);
}

function promptToolUpdate(
	onUpdate: ToolUpdate | undefined,
): ((update: PromptWorkflowUpdate) => Promise<void>) | undefined {
	if (!onUpdate) return undefined;
	return async (update) => {
		await onUpdate(
			toolResult({
				text: update.text,
				data: update,
				status: update.type === "chunk" ? "streaming" : "running",
			}),
		);
	};
}
