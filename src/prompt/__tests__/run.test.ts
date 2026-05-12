import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptRequest,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpSearchRequest,
} from "../../acp/client.ts";
import { loadConfig, saveGeminiAcpSettings } from "../../config/settings.ts";
import { getStoredResult } from "../../storage/results.ts";
import type { SearchResultItem } from "../../types.ts";
import { PROMPT_RESPONSE_INLINE_LIMIT, runPrompt } from "../run.ts";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-prompt-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runPrompt", () => {
	it("executes prompts through an injected Gemini ACP client", async () => {
		const client = new FakeGeminiClient(["Hello", " world"]);
		const result = await runPrompt(
			{ prompt: "Say hello", rootDir, config: {} },
			{ commandExists: async () => true, geminiAcpClient: client },
		);

		expect(result.error).toBeUndefined();
		expect(result.text).toBe("Hello world");
		expect(client.promptText).toBe("Say hello");
	});

	it("uses the default Gemini ACP client factory when no client is injected", async () => {
		let factoryCalls = 0;
		const result = await runPrompt(
			{
				prompt: "Factory",
				rootDir,
				config: {
					providers: {
						"gemini-acp": {
							enabled: true,
							command: "custom-gemini",
							args: ["--acp", "--model", "gemini-test"],
							authenticated: true,
							model: "gemini-test",
							modelSelectionAvailable: true,
						},
					},
				},
			},
			{
				commandExists: async () => true,
				geminiAcpClientFactory: (settings) => {
					factoryCalls += 1;
					expect(settings.command).toBe("custom-gemini");
					expect(settings.args).toEqual(["--acp", "--model", "gemini-test"]);
					return new FakeGeminiClient(["factory response"]);
				},
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.text).toBe("factory response");
		expect(factoryCalls).toBe(1);
	});

	it("prefers an injected Gemini ACP client over the factory seam", async () => {
		let factoryCalls = 0;
		const result = await runPrompt(
			{ prompt: "Injected", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(["injected"]),
				geminiAcpClientFactory: () => {
					factoryCalls += 1;
					return new FakeGeminiClient(["factory"]);
				},
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.text).toBe("injected");
		expect(factoryCalls).toBe(0);
	});

	it("allows the factory seam to reuse a prompt client across calls", async () => {
		const clients = new Map<string, FakeGeminiClient>();
		const factory = (settings: GeminiAcpCommandSettings): GeminiAcpClient => {
			const key = cacheKey(settings);
			return getOrCreateClient(clients, key, () => new FakeGeminiClient(["warm"]));
		};

		await runPrompt(
			{ prompt: "one", rootDir, config: {} },
			{ commandExists: async () => true, geminiAcpClientFactory: factory },
		);
		await runPrompt(
			{ prompt: "two", rootDir, config: {} },
			{ commandExists: async () => true, geminiAcpClientFactory: factory },
		);

		const client = clients.get("gemini --acp");
		expect(clients.size).toBe(1);
		expect(client?.promptCalls).toBe(2);
		expect(client?.promptText).toBe("two");
	});

	it("forwards progress, request summaries, and streaming chunk updates", async () => {
		const updates: Array<{
			type: string;
			text: string;
			request?: unknown;
		}> = [];
		const result = await runPrompt(
			{ prompt: "Stream", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(["A", "B"]),
			},
			undefined,
			async (update) => {
				updates.push({
					type: update.type,
					text: update.text,
					request: progressRequest(update),
				});
			},
		);

		expect(result.text).toBe("AB");
		expect(updates).toEqual([
			{
				type: "progress",
				text: "Checking Gemini ACP configuration.",
				request: undefined,
			},
			expect.objectContaining({
				type: "progress",
				text: "Sending prompt with promptLength 6 via Gemini ACP default.",
				request: expect.objectContaining({
					toolName: "gemini_prompt",
					arguments: expect.objectContaining({
						promptLength: 6,
						model: "Gemini ACP default",
					}),
				}),
			}),
			{
				type: "progress",
				text: "Sending prompt with promptLength 6 via Gemini ACP default.\n\n● Waiting for Gemini backend...",
				request: undefined,
			},
			{
				type: "progress",
				text: "Sending prompt with promptLength 6 via Gemini ACP default.\n\n● First token received; LLM generating tokens...",
				request: undefined,
			},
			{ type: "chunk", text: "A", request: undefined },
			{ type: "chunk", text: "B", request: undefined },
		]);
	});

	it("stores large prompt responses behind a responseId", async () => {
		const fullText = "x".repeat(PROMPT_RESPONSE_INLINE_LIMIT + 10);
		const result = await runPrompt(
			{ prompt: "Long", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient([fullText]),
			},
		);

		expect(result.truncated).toBe(true);
		expect(result.responseId).toBeTruthy();
		expect(result.text.length).toBeLessThan(fullText.length);
		const stored = await getStoredResult<{
			provider: string;
			prompt: string;
			text: string;
		}>(result.responseId!, { rootDir });
		expect(stored.value.text).toBe(fullText);
	});

	it("probes and persists authentication before a provider prompt", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: false,
			},
			{ rootDir },
		);
		let probeCalls = 0;

		const result = await runPrompt(
			{ prompt: "Hi", rootDir },
			{
				commandExists: async () => true,
				authProbe: async () => {
					probeCalls += 1;
					return { authenticated: true };
				},
				geminiAcpClient: new FakeGeminiClient(["ok"]),
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.text).toBe("ok");
		expect(probeCalls).toBe(1);
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]?.authenticated).toBe(true);
	});

	it("returns structured provider preflight errors", async () => {
		const result = await runPrompt(
			{
				prompt: "Hi",
				rootDir,
				config: {
					providers: {
						"gemini-acp": {
							enabled: true,
							command: "gemini",
							authenticated: false,
						},
					},
				},
			},
			{
				commandExists: async () => true,
				authProbe: async () => ({ authenticated: false }),
			},
		);

		expect(result.error?.code).toBe("GEMINI_ACP_UNAUTHENTICATED");
	});

	it("propagates aborted signals to the Gemini ACP client", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runPrompt(
			{ prompt: "Stop", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: new AbortAwareGeminiClient(),
			},
			controller.signal,
		);

		expect(result.error?.code).toBe("GEMINI_ACP_ABORTED");
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	promptText = "";
	promptCalls = 0;

	constructor(private readonly chunks: string[]) {}

	async search(_request: GeminiAcpSearchRequest): Promise<SearchResultItem[]> {
		return [];
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		_signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		this.promptCalls += 1;
		this.promptText = "prompt" in request ? request.prompt : "";
		let accumulatedText = "";
		for (const text of this.chunks) {
			accumulatedText += text;
			await onUpdate?.({ type: "chunk", text, accumulatedText });
		}
		return accumulatedText;
	}
}

class AbortAwareGeminiClient extends FakeGeminiClient {
	constructor() {
		super([]);
	}

	override async prompt(_request: GeminiAcpPromptRequest, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) {
			throw new DOMException("aborted", "AbortError");
		}
		return "not aborted";
	}
}

function cacheKey(settings: GeminiAcpCommandSettings): string {
	return `${settings.command} ${(settings.args ?? []).join(" ")}`;
}

function getOrCreateClient<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
	let client = map.get(key);
	if (!client) {
		client = factory();
		map.set(key, client);
	}
	return client;
}

function progressRequest(update: { type: string; request?: unknown }): unknown {
	return update.type === "progress" ? update.request : undefined;
}
