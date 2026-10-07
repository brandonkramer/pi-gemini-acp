import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeminiAcpClient, GeminiAcpCommandSettings } from "../../acp/client.ts";
import type { GeminiAcpConfig } from "../../types.ts";
import { createGeminiAcpStreamSimple } from "../stream.ts";

const fakePi = {};
const fakeChatConfig = {};
const fakeConfig: GeminiAcpConfig = {};

function makeStream(client: GeminiAcpClient, chatConfig = fakeChatConfig) {
	return createGeminiAcpStreamSimple(fakeConfig, undefined, fakePi, chatConfig, () => client);
}

function fakeModel(id = "gemini-2.5-flash"): Model<"gemini-acp"> {
	return {
		id,
		name: id,
		api: "gemini-acp" as const,
		provider: "gemini-acp",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	};
}

function fakeContext(overrides?: Partial<Context>): Context {
	return {
		messages: [],
		...overrides,
	};
}

describe("createGeminiAcpStreamSimple", () => {
	it("emits balanced text events and done for a successful prompt", async () => {
		const client = {
			prompt: vi.fn(async (_req, _signal, onUpdate) => {
				onUpdate?.({ type: "chunk", text: "Hello ", accumulatedText: "Hello " });
				onUpdate?.({ type: "chunk", text: "world!", accumulatedText: "Hello world!" });
				return "Hello world!";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const stream = makeStream(client)(fakeModel(), fakeContext());
		const events: Array<{ type: string; delta?: string; content?: string }> = [];
		for await (const ev of stream) {
			events.push(ev as (typeof events)[number]);
		}

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(events[2].delta).toBe("Hello ");
		expect(events[3].delta).toBe("world!");
		expect(events[4].content).toBe("Hello world!");
		expect(
			(events[5] as unknown as { message: { content: { text: string }[] } }).message.content[0]
				.text,
		).toBe("Hello world!");
	});

	it("preserves per-chunk partial content independently (no shared textBlock mutation)", async () => {
		const client = {
			prompt: vi.fn(async (_req, _signal, onUpdate) => {
				onUpdate?.({ type: "chunk", text: "Hello ", accumulatedText: "Hello " });
				onUpdate?.({ type: "chunk", text: "world!", accumulatedText: "Hello world!" });
				return "Hello world!";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const stream = makeStream(client)(fakeModel(), fakeContext());
		const deltas: Array<{ partial: { content: Array<{ type: string; text: string }> } }> = [];
		for await (const ev of stream) {
			if (ev.type === "text_delta") deltas.push(ev as unknown as (typeof deltas)[number]);
		}

		// If a shared textBlock were mutated, both partials would show the final accumulated text.
		expect(deltas[0].partial.content[0].text).toBe("Hello ");
		expect(deltas[1].partial.content[0].text).toBe("Hello world!");
	});

	it("shows tool calls and policy denials as thinking when Pi cannot show tool entries", async () => {
		const client = {
			prompt: vi.fn(async (_req, _signal, onUpdate, observers) => {
				observers?.onActivity?.({ type: "thought", text: "Checking the tree." });
				observers?.onActivity?.({
					type: "tool",
					toolCallId: "1",
					kind: "execute",
					status: "in_progress",
					title: "git status --short",
				});
				observers?.onActivity?.({ type: "tool", toolCallId: "1", status: "completed" });
				observers?.onActivity?.({
					type: "permission",
					kind: "edit",
					title: "a.txt",
					capability: "filesystemWrite",
					outcome: "cancelled",
				});
				onUpdate?.({ type: "chunk", text: "Clean.", accumulatedText: "Clean." });
				return "Clean.";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const stream = makeStream(client)(fakeModel(), fakeContext());
		const types: string[] = [];
		for await (const ev of stream) types.push(ev.type);
		const message = await stream.result();

		expect(types).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(message.content).toEqual([
			{
				type: "thinking",
				thinking:
					"Checking the tree.\n▸ Shell: git status --short\n✗ Denied by the Gemini ACP permission policy, which does not allow file writes (a.txt). Use /gemini-config permissions to change it.\n",
			},
			{ type: "text", text: "Clean." },
		]);
	});

	it("uses the token counts and stop reason Gemini reports", async () => {
		const client = {
			prompt: vi.fn(async (_req, _signal, _onUpdate, observers) => {
				observers?.onOutcome?.({
					stopReason: "max_tokens",
					usage: {
						inputTokens: 1000,
						outputTokens: 10,
						models: [{ model: "gemini-2.5-pro", inputTokens: 1000, outputTokens: 10 }],
					},
				});
				return "partial answer";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const message = await makeStream(client)(fakeModel("gemini-auto"), fakeContext()).result();
		expect(message.stopReason).toBe("length");
		expect(message.usage.input).toBe(1000);
		expect(message.usage.output).toBe(10);
		// Priced as the Pro model that served the turn, not as the gemini-auto default.
		expect(message.usage.cost.total).toBeCloseTo((1000 * 1.25 + 10 * 10) / 1_000_000);
	});

	it("reports a refused turn as an error", async () => {
		const client = {
			prompt: vi.fn(async (_req, _signal, _onUpdate, observers) => {
				observers?.onOutcome?.({ stopReason: "refusal" });
				return "";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const message = await makeStream(client)(fakeModel(), fakeContext()).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/refused/u);
	});

	it("passes the request through onPayload and sends a replacement", async () => {
		const prompt = vi.fn(async () => "ok");
		const client = { prompt, search: vi.fn() } as unknown as GeminiAcpClient;
		const onPayload = vi.fn((payload: unknown) => ({
			...(payload as object),
			parts: [{ type: "text", text: "replaced" }],
		}));
		await makeStream(client)(
			fakeModel(),
			fakeContext({ messages: [{ role: "user", content: "original", timestamp: 0 }] }),
			{ onPayload },
		).result();
		expect(onPayload).toHaveBeenCalledOnce();
		const request = (
			prompt.mock.calls as unknown as Array<[{ parts: Array<{ text: string }> }]>
		)[0][0];
		expect(request.parts).toEqual([{ type: "text", text: "replaced" }]);
	});

	it("emits error when the ACP client throws", async () => {
		const client = {
			prompt: vi.fn(async () => {
				throw new Error("ACP session failed");
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const stream = makeStream(client)(fakeModel(), fakeContext());
		const events: unknown[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		expect(events).toHaveLength(2);
		expect((events[0] as { type: string }).type).toBe("start");
		expect((events[1] as { type: string }).type).toBe("error");
		expect((events[1] as { error: { errorMessage: string } }).error.errorMessage).toBe(
			"ACP session failed",
		);
	});

	it("respects AbortSignal and emits aborted error", async () => {
		const client = {
			prompt: vi.fn(async (_req, signal) => {
				return await new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const controller = new AbortController();
		const stream = makeStream(client)(fakeModel(), fakeContext(), {
			signal: controller.signal,
		});

		// Let the stream worker start and reach client.prompt before aborting
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});
		controller.abort();

		const events: unknown[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		expect(events.length).toBeGreaterThanOrEqual(1);
		expect((events.at(-1) as { type: string }).type).toBe("error");
		expect((events.at(-1) as { error: { stopReason: string } }).error.stopReason).toBe("aborted");
	});

	it("flattens multi-turn context into a single ACP prompt", async () => {
		const client = {
			prompt: vi.fn(async (req) => {
				return req.parts.map((p: { type: string; text: string }) => p.text).join("\n");
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const context = fakeContext({
			systemPrompt: "Be helpful",
			messages: [
				{ role: "user", content: "Hello", timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi" }],
					timestamp: 0,
					api: "gemini-acp",
					provider: "gemini-acp",
					model: "gemini-1.5-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
				},
			] as unknown as Context["messages"],
		});

		const stream = makeStream(client)(fakeModel(), context);
		const events: unknown[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		expect(
			(events.at(-1) as { message: { content: { text: string }[] } }).message.content[0].text,
		).toContain("Be helpful");
		expect(
			(events.at(-1) as { message: { content: { text: string }[] } }).message.content[0].text,
		).toContain("User: Hello");
		expect(
			(events.at(-1) as { message: { content: { text: string }[] } }).message.content[0].text,
		).toContain("Assistant: Hi");
	});

	it("reads the system prompt from a normalized Pi transcript and skips system messages", async () => {
		const prompt = vi.fn(async () => "ok");
		const client = { prompt, search: vi.fn() } as unknown as GeminiAcpClient;
		const transcript = normalizeContext({
			systemPrompt: "Pi system prompt",
			tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		} as unknown as Context);
		// A later system message, as Pi sends when the system prompt or tool set changes.
		transcript.messages.push({
			role: "system",
			content: "",
			sections: { extra: "Extra section" },
			timestamp: 2,
		} as unknown as Context["messages"][0]);
		await makeStream(client, {
			appendSystemPrompt: false,
			appendAgents: false,
			appendTools: false,
		})(fakeModel(), transcript as unknown as Context).result();
		const request = (
			prompt.mock.calls as unknown as Array<[{ parts: Array<{ text: string }> }]>
		)[0][0];
		expect(request.parts.map((p) => p.text)).toEqual([
			"Pi system prompt\n\nExtra section",
			"User: hello",
		]);
	});

	it("counts the system prompt against maxHistoryChars", async () => {
		const prompt = vi.fn(async () => "ok");
		const client = { prompt, search: vi.fn() } as unknown as GeminiAcpClient;
		await makeStream(client, {
			appendSystemPrompt: false,
			appendAgents: false,
			appendTools: false,
			maxHistoryChars: 100,
		})(
			fakeModel(),
			fakeContext({
				systemPrompt: "S".repeat(80),
				messages: [
					{ role: "user", content: "old request", timestamp: 0 },
					{ role: "user", content: "current request", timestamp: 1 },
				],
			}),
		).result();
		const request = (
			prompt.mock.calls as unknown as Array<[{ parts: Array<{ text: string }> }]>
		)[0][0];
		// 80 characters of system prompt leave 20: "User: old request" no longer fits.
		expect(request.parts.map((p) => p.text)).toEqual([
			"S".repeat(80),
			"[1 earlier message omitted to stay within chat.maxHistoryChars]",
			"User: current request",
		]);
	});

	it("keeps only the current message when maxHistoryMessages is zero", async () => {
		const prompt = vi.fn(async () => "ok");
		const client = { prompt, search: vi.fn() } as unknown as GeminiAcpClient;
		await makeStream(client, { maxHistoryMessages: 0 })(
			fakeModel(),
			fakeContext({
				messages: [
					{ role: "user", content: "old request", timestamp: 0 },
					{ role: "user", content: "current request", timestamp: 1 },
				],
			}),
		).result();
		const request = (
			prompt.mock.calls as unknown as Array<[{ parts: Array<{ text: string }> }]>
		)[0][0];
		expect(request.parts.map((p) => p.text).join("\n")).toContain("current request");
		expect(request.parts.map((p) => p.text).join("\n")).not.toContain("old request");
	});

	it("truncates conversation history to maxHistoryMessages", async () => {
		const client = {
			prompt: vi.fn(async (req) => {
				return req.parts.map((p: { type: string; text: string }) => p.text).join("\n");
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const messages = makeTestHistoryMessages(6);

		const context = fakeContext({ messages: messages as unknown as Context["messages"] });
		const stream = makeStream(client, { maxHistoryMessages: 2 })(fakeModel(), context);
		const events: unknown[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		const text = (events.at(-1) as { message: { content: { text: string }[] } }).message.content[0]
			.text;
		expect(text).toContain("User: Q4");
		expect(text).toContain("Assistant: A5");
		expect(text).not.toContain("User: Q0");
		expect(text).not.toContain("Assistant: A1");
	});
});

describe("createGeminiAcpStreamSimple account pool failover (file-backed)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-gemini-stream-test-"));
		await mkdir(path.join(tmpDir, "config"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("routes chat turns through executeWithAccountPool and skips cooled-down primary", async () => {
		// Write a cooldown file marking primary as exhausted.
		await writeFile(
			path.join(tmpDir, "config", "account-cooldowns.json"),
			JSON.stringify([
				{
					accountName: "primary",
					coolUntil: Date.now() + 3_600_000,
					reason: "quota exhausted",
				},
			]),
		);

		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini", args: ["--acp"] },
				accounts: {
					failover: { retries: 0, codes: [429], coolDownSeconds: 3600 },
					entries: [
						{ name: "primary", env: { GEMINI_CLI_HOME: "/primary" } },
						{ name: "secondary", env: { GEMINI_CLI_HOME: "/secondary" } },
					],
				},
			},
		};

		const usedSettings: GeminiAcpCommandSettings[] = [];
		const clientFactory = (settings: GeminiAcpCommandSettings): GeminiAcpClient => {
			usedSettings.push(settings);
			return {
				prompt: vi.fn(async () => "reply from secondary"),
				search: vi.fn(),
			} as unknown as GeminiAcpClient;
		};

		const streamFn = createGeminiAcpStreamSimple(
			config,
			config.providers?.["gemini-acp"],
			fakePi,
			fakeChatConfig,
			clientFactory,
			tmpDir,
		);
		const stream = streamFn(
			{
				id: "gemini-2.5-flash",
				name: "Gemini 2.5 Flash",
				api: "gemini-acp" as const,
				provider: "gemini-acp",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 8192,
			},
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context,
		);
		const events: unknown[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		// Must have succeeded (done event, not error).
		expect((events.at(-1) as { type: string }).type).toBe("done");
		// Must have only tried secondary — primary was cooled down.
		expect(usedSettings).toHaveLength(1);
		expect(usedSettings[0]?.env?.GEMINI_CLI_HOME).toBe("/secondary");
		expect(usedSettings[0]?.args).toContain("gemini-2.5-flash");
	});
});

function makeTestHistoryMessages(count: number): Context["messages"] {
	return Array.from({ length: count }, (_, i) =>
		i % 2 === 0
			? ({ role: "user", content: `Q${i}`, timestamp: i } as unknown as Context["messages"][0])
			: ({
					role: "assistant",
					content: [{ type: "text", text: `A${i}` }],
					timestamp: i,
					api: "gemini-acp",
					provider: "gemini-acp",
					model: "gemini-1.5-flash",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
				} as unknown as Context["messages"][0]),
	);
}
