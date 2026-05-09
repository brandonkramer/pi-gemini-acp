/**
 * @fileoverview Internal prompt route used by the gemini_ask umbrella tool.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import {
	type PromptRunResult,
	type PromptWorkflowUpdate,
	runPrompt,
} from "../prompt/run.js";
import type { PiToolShell } from "../types.js";
import type { ToolRenderResultOptions, ToolUpdate } from "../tools/define.js";
import {
	appendExpansionHint,
	isRecord,
	renderPromptToolResult,
	resultMetadataLines,
	storedOutputLine,
} from "../tools/gemini-prompt-rendering.js";
import { truncateToolText } from "../tools/gemini-rendering.js";
import { withToolResponseCache } from "../tools/cache.js";
import { toolResultWithCost } from "../tools/cost-estimate.js";
import { errorResult, toolResult } from "../tools/result.js";

const askPromptParamsSchema = Type.Object({
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

type Params = Static<typeof askPromptParamsSchema>;

export const askPromptRoute = {
	async execute(
		toolCallId: string,
		params: Params,
		signal: AbortSignal,
		onUpdate?: ToolUpdate,
	) {
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
				return toolResultWithCost(
					toolCallId,
					"gemini_ask",
					params.prompt,
					result.text,
					{},
					{
						text: result.truncated
							? `Gemini ACP response stored as responseId ${result.responseId}. Preview:\n${result.text}`
							: `Gemini ACP response:\n${result.text}`,
						data: result,
						responseId: result.responseId,
						fullOutputPath: result.fullOutputPath,
					},
				);
			},
		});
	},
	renderResult(
		result: PiToolShell,
		options: ToolRenderResultOptions,
		theme: unknown,
	) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_prompt",
			isData: isPromptRunResult,
			collapsed: formatPromptCollapsedDisplay,
			expanded: formatPromptExpandedDisplay,
		});
	},
};

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
