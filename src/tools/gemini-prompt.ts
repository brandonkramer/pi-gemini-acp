import { type Static, Type } from "@mariozechner/pi-ai";
import { type PromptWorkflowUpdate, runPrompt } from "../prompt/run.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpPromptSchema = Type.Object({
	prompt: Type.String({
		minLength: 1,
		description: "Plain text prompt to send to the configured Gemini ACP.",
	}),
});

type Params = Static<typeof geminiAcpPromptSchema>;

export const geminiAcpPromptTool = defineGeminiTool({
	name: "gemini_prompt",
	label: "Gemini ACP Prompt",
	description:
		"Send a plain text prompt to a configured, authenticated local Gemini ACP command. Requires local ACP setup/auth; no local/no-key fallback is available for arbitrary prompts.",
	parameters: geminiAcpPromptSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
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
