/**
 * @file Fingerprints Pi's conversation so the ACP client can continue the Gemini session that
 *   already holds it and send only the new messages, instead of replaying the whole history into a
 *   fresh session on every turn.
 */
import { createHash } from "node:crypto";

import type { GeminiAcpConversation } from "../acp/client.ts";
import { messageText, messageToText, type ConversationMessage } from "./transcript.ts";

/**
 * Describes the conversation for one chat turn. `context` must contain everything besides the
 * messages that the Gemini session was primed with (model, preamble/system prompt): when it
 * changes, the earlier session is not reused.
 */
export function buildConversation(
	messages: readonly ConversationMessage[],
	context: string,
): GeminiAcpConversation {
	return {
		contextKey: fingerprint("context", context),
		transcript: messages.map((message) => messageFingerprint(message)),
		continuationParts: (from) =>
			messages.slice(from).map((message) => ({ type: "text", text: messageToText(message) })),
		replyFingerprint: (text) => fingerprint("assistant", text),
	};
}

/** Identifies a message by role and text. Pi stores Gemini's reply with the streamed text. */
export function messageFingerprint(message: ConversationMessage): string {
	const role = message.role === "toolResult" ? `toolResult:${message.toolName}` : message.role;
	return fingerprint(role, messageText(message));
}

function fingerprint(kind: string, text: string): string {
	return createHash("sha256")
		.update(kind)
		.update("\0")
		.update(text.trim())
		.digest("hex")
		.slice(0, 32);
}
