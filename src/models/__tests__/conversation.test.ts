import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { buildConversation } from "../conversation.ts";
import type { ConversationMessage } from "../transcript.ts";

const reply = {
	role: "assistant",
	// As built by AssistantMessageBuilder: thinking between two text blocks.
	content: [
		{ type: "text", text: "Hello " },
		{ type: "thinking", thinking: "▸ Shell: ls\n" },
		{ type: "text", text: "world.\n" },
	],
	api: "gemini-acp",
	provider: "gemini-acp",
	model: "gemini-auto",
	stopReason: "stop",
	timestamp: 2,
} as unknown as AssistantMessage;

const messages: ConversationMessage[] = [
	{ role: "user", content: "hi", timestamp: 1 },
	reply,
	{
		role: "toolResult",
		toolCallId: "t",
		toolName: "bash",
		content: [{ type: "text", text: "out" }],
		isError: false,
		timestamp: 3,
	},
	{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 4 },
];

describe("buildConversation", () => {
	it("fingerprints Pi's stored reply like the answer text the client returned", () => {
		const conversation = buildConversation(messages, "ctx");
		// The client trims the streamed answer before recording it.
		expect(conversation.transcript[1]).toBe(conversation.replyFingerprint("Hello world."));
	});

	it("builds continuation parts for the messages after a given index", () => {
		expect(buildConversation(messages, "ctx").continuationParts(2)).toEqual([
			{ type: "text", text: "Tool (bash): out" },
			{ type: "text", text: "User: next" },
		]);
	});

	it("separates contexts and distinguishes tool results by tool name", () => {
		const a = buildConversation(messages, "ctx");
		expect(buildConversation(messages, "ctx").contextKey).toBe(a.contextKey);
		expect(buildConversation(messages, "other").contextKey).not.toBe(a.contextKey);
		const renamed = buildConversation(
			messages.map((message) =>
				message.role === "toolResult" ? { ...message, toolName: "read" } : message,
			),
			"ctx",
		);
		expect(renamed.transcript[2]).not.toBe(a.transcript[2]);
	});
});
