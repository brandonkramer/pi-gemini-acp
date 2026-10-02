/**
 * @file Reads Pi's request context in both shapes it has used. Pi before 0.8x passed `systemPrompt`
 *   and `tools` as fields of the context. Newer Pi normalizes the context into a transcript first:
 *   the system prompt and tool declarations move into `role: "system"` messages, which can also
 *   appear later in the conversation. The rules below mirror pi-ai's `getCurrentSystemPrompt()`,
 *   which older Pi does not export.
 */
import type { Context, Message } from "@earendil-works/pi-ai";

interface SystemMessageShape {
	role: "system";
	content?: unknown;
	sections?: Record<string, string | null>;
}

/** Messages of the conversation itself, without system messages. */
export type ConversationMessage = Exclude<Message, { role: "system" }>;

/** Pi's current system prompt, or undefined when the request carries none. */
export function currentSystemPrompt(context: Context): string | undefined {
	if (typeof context.systemPrompt === "string" && context.systemPrompt.length > 0) {
		return context.systemPrompt;
	}
	const content: string[] = [];
	const sections = new Map<string, string>();
	for (const message of context.messages) {
		if (!isSystemMessage(message)) continue;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const prompt = [content.join("\n\n"), ...sections.values()]
		.filter((part) => part.length > 0)
		.join("\n\n");
	return prompt.length > 0 ? prompt : undefined;
}

/** The user, assistant and tool-result messages, in order. */
export function conversationMessages(context: Context): ConversationMessage[] {
	return context.messages.filter(
		(message): message is ConversationMessage => !isSystemMessage(message),
	);
}

function isSystemMessage(message: unknown): message is SystemMessageShape {
	return (message as { role?: unknown } | null | undefined)?.role === "system";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}
