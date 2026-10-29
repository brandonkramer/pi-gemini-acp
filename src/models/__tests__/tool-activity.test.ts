import type { Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeminiAcpClient } from "../../acp/client.ts";
import { createGeminiAcpStreamSimple } from "../stream.ts";
import {
	GEMINI_TOOL_ENTRY_TYPE,
	installToolActivityHost,
	renderGeminiToolEntry,
	resetToolActivityHost,
	type GeminiToolEntryData,
	type ToolActivityApi,
} from "../tool-activity.ts";

type Handler = Parameters<NonNullable<ToolActivityApi["on"]>>[1];

/** A Pi double that records entries and working messages. */
function fakePi(hasUI = true) {
	const entries: Array<{ customType: string; data: GeminiToolEntryData }> = [];
	const working: Array<string | undefined> = [];
	const handlers = new Map<string, Handler>();
	let renderer: Parameters<NonNullable<ToolActivityApi["registerEntryRenderer"]>>[1] | undefined;
	const pi: ToolActivityApi = {
		appendEntry: (customType, data) =>
			entries.push({ customType, data: data as GeminiToolEntryData }),
		registerEntryRenderer: (customType, render) => {
			expect(customType).toBe(GEMINI_TOOL_ENTRY_TYPE);
			renderer = render;
		},
		on: (event, handler) => handlers.set(event, handler),
	};
	const ctx = { hasUI, ui: { setWorkingMessage: (message?: string) => working.push(message) } };
	return {
		pi,
		entries,
		working,
		renderer: () => renderer,
		emit: (event: "agent_start" | "agent_end") => handlers.get(event)?.({}, ctx),
	};
}

const model = { id: "gemini-2.5-flash", provider: "gemini-acp" } as Model<"gemini-acp">;
const context: Context = { messages: [] };

function streamWith(client: GeminiAcpClient) {
	return createGeminiAcpStreamSimple({}, undefined, {}, {}, () => client)(model, context);
}

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function renderText(data: GeminiToolEntryData, expanded = false): string {
	const component = renderGeminiToolEntry(data, expanded, theme);
	return (component?.render(200) ?? []).map((line) => line.trimEnd()).join("\n");
}

afterEach(() => resetToolActivityHost());

describe("Gemini tool entries in a chat turn", () => {
	it("saves each tool call as an entry and keeps only thoughts as thinking", async () => {
		const host = fakePi();
		installToolActivityHost(host.pi);
		host.emit("agent_start");
		const client = {
			prompt: vi.fn(async (_req, _signal, onUpdate, observers) => {
				observers?.onActivity?.({ type: "thought", text: "Checking the tree." });
				observers?.onActivity?.({
					type: "tool",
					toolCallId: "1",
					kind: "execute",
					status: "in_progress",
					title: "git status --short",
					output: "[current working directory /tmp] (Show status)",
				});
				observers?.onActivity?.({
					type: "tool",
					toolCallId: "1",
					status: "completed",
					output: " M a.txt\n",
				});
				// Gemini reports a call rejected before it ran only by its end.
				observers?.onActivity?.({
					type: "tool",
					toolCallId: "2",
					kind: "read",
					status: "failed",
					output: "Path not in workspace",
				});
				observers?.onActivity?.({
					type: "permission",
					kind: "edit",
					title: "a.txt",
					capability: "filesystemWrite",
					outcome: "cancelled",
				});
				onUpdate?.({ type: "chunk", text: "Done.", accumulatedText: "Done." });
				return "Done.";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const message = await streamWith(client).result();

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "Checking the tree." },
			{ type: "text", text: "Done." },
		]);
		expect(host.entries).toEqual([
			{
				customType: GEMINI_TOOL_ENTRY_TYPE,
				data: {
					status: "completed",
					kind: "execute",
					title: "git status --short",
					output: " M a.txt",
					durationMs: expect.any(Number),
				},
			},
			{
				customType: GEMINI_TOOL_ENTRY_TYPE,
				data: {
					status: "failed",
					kind: "read",
					title: undefined,
					output: "Path not in workspace",
					durationMs: undefined,
				},
			},
			{
				customType: GEMINI_TOOL_ENTRY_TYPE,
				data: {
					status: "notice",
					title: expect.stringContaining("does not allow file writes (a.txt)"),
				},
			},
		]);
		expect(host.working).toEqual([
			"Gemini · step 1 · Shell: git status --short",
			"Gemini · step 1 · thinking",
			"Gemini · step 2 · thinking",
			undefined,
		]);
	});

	it("saves calls still running when the turn fails and restores the working line", async () => {
		const host = fakePi();
		installToolActivityHost(host.pi);
		host.emit("agent_start");
		const client = {
			prompt: vi.fn(async (_req, _signal, _onUpdate, observers) => {
				observers?.onActivity?.({
					type: "tool",
					toolCallId: "1",
					kind: "execute",
					status: "in_progress",
					title: "make check",
				});
				throw new Error("Gemini stopped");
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const message = await streamWith(client).result();

		expect(message.stopReason).toBe("error");
		expect(host.entries.map((entry) => entry.data)).toEqual([
			{
				status: "unfinished",
				kind: "execute",
				title: "make check",
				durationMs: expect.any(Number),
			},
		]);
		expect(host.working.at(-1)).toBeUndefined();
	});

	it("does not touch the working line without a UI", async () => {
		const host = fakePi(false);
		installToolActivityHost(host.pi);
		host.emit("agent_start");
		const client = {
			prompt: vi.fn(async (_req, _signal, _onUpdate, observers) => {
				observers?.onActivity?.({ type: "tool", toolCallId: "1", status: "completed" });
				return "ok";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		await streamWith(client).result();

		expect(host.entries).toHaveLength(1);
		expect(host.working).toEqual([]);
	});

	it("keeps only the end of long output", async () => {
		const host = fakePi();
		installToolActivityHost(host.pi);
		const output = Array.from({ length: 250 }, (_, index) => `line ${index}`).join("\n");
		const client = {
			prompt: vi.fn(async (_req, _signal, _onUpdate, observers) => {
				observers?.onActivity?.({ type: "tool", toolCallId: "1", status: "completed", output });
				return "ok";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		await streamWith(client).result();

		const data = host.entries[0]?.data;
		expect(data?.outputTruncated).toBe(true);
		expect(data?.output?.split("\n")).toHaveLength(200);
		expect(data?.output?.endsWith("line 249")).toBe(true);
	});

	it("falls back to thinking text when Pi has no appendEntry", async () => {
		installToolActivityHost({});
		const client = {
			prompt: vi.fn(async (_req, _signal, _onUpdate, observers) => {
				observers?.onActivity?.({
					type: "tool",
					toolCallId: "1",
					kind: "execute",
					status: "completed",
					title: "git log",
				});
				return "ok";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const message = await streamWith(client).result();

		expect(message.content[0]).toEqual({ type: "thinking", thinking: "▸ Shell: git log\n" });
	});
});

describe("renderGeminiToolEntry", () => {
	const shell: GeminiToolEntryData = {
		status: "completed",
		kind: "execute",
		title: "ls /etc",
		output: ["a", "b", "c", "d", "e", "f", "g"].join("\n"),
		durationMs: 1234,
	};

	it("shows a shell call like Pi's bash tool, collapsed to the last lines", () => {
		const text = renderText(shell);
		expect(text).toContain("<toolTitle>$ ls /etc</toolTitle>");
		expect(text).toContain("... (2 earlier lines, ctrl+o to expand)");
		expect(text).not.toContain("<toolOutput>b</toolOutput>");
		expect(text).toContain("<toolOutput>g</toolOutput>");
		expect(text).toContain("<dim>Took 1.2s</dim>");
	});

	it("shows all kept output when expanded", () => {
		const text = renderText(shell, true);
		expect(text).toContain("<toolOutput>a</toolOutput>");
		expect(text).not.toContain("earlier lines");
	});

	it("labels other tools and marks failures and unfinished calls", () => {
		expect(renderText({ status: "failed", kind: "read", output: "denied" })).toMatch(
			/Gemini Read[\s\S]*<error>Failed<\/error>/u,
		);
		expect(renderText({ status: "unfinished", kind: "execute", title: "make" })).toContain(
			"<warning>Did not finish before the turn ended</warning>",
		);
		expect(renderText({ status: "notice", title: "✗ Denied" })).toContain(
			"<warning>✗ Denied</warning>",
		);
	});

	it("ignores entries it cannot read", () => {
		expect(renderGeminiToolEntry(undefined, false, theme)).toBeUndefined();
	});
});
