import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Context, Model } from "@earendil-works/pi-ai";
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
	it("emits start, text_delta, and done for a successful prompt", async () => {
		const client = {
			prompt: vi.fn(async (_req, _signal, onUpdate) => {
				onUpdate?.({ type: "chunk", text: "Hello ", accumulatedText: "Hello " });
				onUpdate?.({ type: "chunk", text: "world!", accumulatedText: "Hello world!" });
				return "Hello world!";
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const stream = makeStream(client)(fakeModel(), fakeContext());
		const events: unknown[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		expect(events).toHaveLength(4);
		expect((events[0] as { type: string }).type).toBe("start");
		expect((events[1] as { type: string }).type).toBe("text_delta");
		expect((events[1] as { delta: string }).delta).toBe("Hello ");
		expect((events[2] as { type: string }).type).toBe("text_delta");
		expect((events[2] as { delta: string }).delta).toBe("world!");
		expect((events[3] as { type: string }).type).toBe("done");
		expect(
			(events[3] as { message: { content: { text: string }[] } }).message.content[0].text,
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
		const events: unknown[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		const firstDelta = events[1] as {
			type: string;
			partial: { content: Array<{ type: string; text: string }> };
		};
		const secondDelta = events[2] as {
			type: string;
			partial: { content: Array<{ type: string; text: string }> };
		};
		// If a shared textBlock were mutated, both partials would show the final accumulated text.
		expect(firstDelta.partial.content[0].text).toBe("Hello ");
		expect(secondDelta.partial.content[0].text).toBe("Hello world!");
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
		await new Promise((resolve) => setTimeout(resolve, 50));
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

	it("truncates conversation history to maxHistoryMessages", async () => {
		const client = {
			prompt: vi.fn(async (req) => {
				return req.parts.map((p: { type: string; text: string }) => p.text).join("\n");
			}),
			search: vi.fn(),
		} as unknown as GeminiAcpClient;

		const messages = Array.from({ length: 6 }, (_, i) =>
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
	});
});
