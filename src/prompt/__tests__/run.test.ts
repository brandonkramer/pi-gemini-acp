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
} from "../../acp/client.js";
import { getStoredResult } from "../../storage/results.js";
import type { SearchResultItem } from "../../types.js";
import { PROMPT_RESPONSE_INLINE_LIMIT, runPrompt } from "../run.js";

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
			const key = `${settings.command} ${(settings.args ?? []).join(" ")}`;
			let client = clients.get(key);
			if (!client) {
				client = new FakeGeminiClient(["warm"]);
				clients.set(key, client);
			}
			return client;
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

	it("forwards progress and streaming chunk updates", async () => {
		const updates: Array<{ type: string; text: string }> = [];
		const result = await runPrompt(
			{ prompt: "Stream", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(["A", "B"]),
			},
			undefined,
			async (update) => {
				updates.push({ type: update.type, text: update.text });
			},
		);

		expect(result.text).toBe("AB");
		expect(updates).toEqual([
			{ type: "progress", text: "Checking Gemini ACP configuration." },
			{ type: "progress", text: "Sending prompt to Gemini ACP." },
			{ type: "chunk", text: "A" },
			{ type: "chunk", text: "B" },
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
		}>(result.responseId ?? "", { rootDir });
		expect(stored.value.text).toBe(fullText);
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
			{ commandExists: async () => true },
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
		this.promptText = request.prompt;
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

	override async prompt(
		_request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
	): Promise<string> {
		if (signal?.aborted) {
			throw new DOMException("aborted", "AbortError");
		}
		return "not aborted";
	}
}
