/** @file Shared Gemini backend-wait and first-token progress helpers. */
import type { GeminiAcpPromptUpdateHandler } from "./client.ts";

export type GeminiBackendProgressState = "waiting" | "generating";
export type GeminiBackendProgressEmitter = (message: string) => void | Promise<void>;

const BACKEND_PROGRESS_TEXT: Record<GeminiBackendProgressState, string> = {
	waiting: "● Waiting for Gemini backend...",
	generating: "● First token received; LLM generating tokens...",
};

/** Formats the shared Gemini backend progress message, optionally under a header. */
export function geminiBackendProgressText(
	state: GeminiBackendProgressState,
	header?: string,
): string {
	const text = BACKEND_PROGRESS_TEXT[state];
	return header ? `${header}\n\n${text}` : text;
}

/** Emits a shared Gemini backend progress message. */
export async function emitGeminiBackendProgress(
	emit: GeminiBackendProgressEmitter | undefined,
	state: GeminiBackendProgressState,
	header?: string,
): Promise<void> {
	await emit?.(geminiBackendProgressText(state, header));
}

/** Wraps a prompt chunk handler and emits first-token progress exactly once. */
export function withGeminiBackendProgress(
	onUpdate?: GeminiAcpPromptUpdateHandler,
	emit?: GeminiBackendProgressEmitter,
	header?: string,
): GeminiAcpPromptUpdateHandler {
	let receivedFirstToken = false;
	return async (chunk) => {
		if (!receivedFirstToken) {
			receivedFirstToken = true;
			await emitGeminiBackendProgress(emit, "generating", header);
		}
		await onUpdate?.(chunk);
	};
}
