/** @file Prompt workflow progress adapter helpers. */
import type { PromptUpdateHandler } from "./run.js";

/** Adapts shared Gemini backend progress text into prompt workflow updates. */
export function promptWorkflowProgressEmitter(
	onUpdate: PromptUpdateHandler | undefined,
	phase: string,
): ((message: string) => Promise<void>) | undefined {
	if (!onUpdate) return undefined;
	return async (text) => {
		await onUpdate({ type: "progress", phase, text });
	};
}
