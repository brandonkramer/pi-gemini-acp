import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	GeminiAcpClient,
	GeminiAcpPromptRequest,
	GeminiAcpSearchRequest,
} from "../../acp/client.ts";
import { getStoredResult } from "../../storage/results.ts";
import type { GeminiAcpConfig, SearchResultItem } from "../../types.ts";
import { PROMPT_RESPONSE_INLINE_LIMIT } from "../run.ts";
import { buildTranslatePrompt, runTranslate } from "../translate.ts";

let rootDir: string;

const configuredGeminiAcp: GeminiAcpConfig = {
	providers: {
		"gemini-acp": {
			enabled: true,
			command: "gemini",
			authenticated: true,
			requiresSearchGrounding: false,
		},
	},
};

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-translate-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runTranslate", () => {
	it("translates provided text through an injected Gemini ACP client", async () => {
		const client = new FakeGeminiClient("Hola mundo");
		const updates: Array<{ phase?: string; text: string; request?: unknown }> = [];
		const result = await runTranslate(
			{
				text: "Hello world",
				targetLanguage: "Spanish",
				rootDir,
				config: configuredGeminiAcp,
			},
			{ commandExists: async () => true, geminiAcpClient: client },
			undefined,
			(update) => {
				updates.push({
					phase: update.type === "progress" ? update.phase : undefined,
					text: update.text,
					request: update.type === "progress" ? update.request : undefined,
				});
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.translatedText).toBe("Hola mundo");
		expect(result.provider).toBe("gemini-acp");
		expect(client.promptText).toContain("Target language: Spanish");
		expect(client.promptText).toContain('Source text JSON: {"text":"Hello world"}');
		const providerPrompt = updates.find((update) => update.phase === "provider_prompt");
		expect(providerPrompt?.text).toContain('Sending translation prompt: "Spanish"');
		expect(providerPrompt?.text).toContain("targetLanguage Spanish");
		expect(providerPrompt?.text).toContain("mode single");
		expect(providerPrompt?.text).toContain("itemCount 1");
		expect(providerPrompt?.text).toContain("totalChars 11");
		expect(providerPrompt?.text).not.toContain("Hello world");
		expect(providerPrompt?.request).toMatchObject({
			toolName: "gemini_translate",
			arguments: expect.objectContaining({
				targetLanguage: "Spanish",
				itemCount: 1,
			}),
		});
	});

	it("builds deterministic glossary and preservation instructions", () => {
		const prompt = buildTranslatePrompt({
			text: "Keep {count} Pi tools",
			targetLanguage: "French",
			glossary: [
				{ source: "tool", target: "outil" },
				{ source: "Pi", target: "Pi", note: "product name" },
			],
			preserve: ["{count}", "Pi", "{count}"],
			preservationRules: ["Keep ICU placeholders intact.", "Retain Markdown links."],
		});

		expect(prompt).toContain(
			["Glossary:", '1. "Pi" => "Pi" (product name)', '2. "tool" => "outil"'].join("\n"),
		);
		expect(prompt).toContain(["Preserve unchanged:", '1. "{count}"', '2. "Pi"'].join("\n"));
		expect(prompt).toContain(
			["Preservation rules:", "1. Keep ICU placeholders intact.", "2. Retain Markdown links."].join(
				"\n",
			),
		);
	});

	it("keeps batch translation results ordered and preserves partial errors", async () => {
		const client = new FakeGeminiClient(
			JSON.stringify([
				{ index: 0, id: "a", translation: "Bonjour" },
				{ index: 1, id: "b", translation: "", error: "ambiguous source" },
			]),
		);
		const result = await runTranslate(
			{
				batch: [
					{ id: "a", text: "Hello" },
					{ id: "b", text: "Set" },
				],
				targetLanguage: "French",
				rootDir,
				config: configuredGeminiAcp,
			},
			{ commandExists: async () => true, geminiAcpClient: client },
		);

		expect(result.error).toBeUndefined();
		expect(result.mode).toBe("batch");
		expect(result.items).toEqual([
			{ index: 0, id: "a", translation: "Bonjour", error: undefined },
			{ index: 1, id: "b", translation: "", error: "ambiguous source" },
		]);
		expect(client.promptText).toContain("Preserve input order");
		expect(client.promptText).toContain("For a partial item failure");
	});

	it("returns structured missing-config errors without local fallback", async () => {
		const result = await runTranslate({
			text: "Hello",
			targetLanguage: "Spanish",
			rootDir,
			config: {},
		});

		expect(result.error).toMatchObject({
			code: "GEMINI_ACP_MISSING_CONFIG",
			phase: "provider_preflight",
			provider: "gemini-acp",
		});
	});

	it("stores large translations behind a responseId", async () => {
		const fullText = "x".repeat(PROMPT_RESPONSE_INLINE_LIMIT + 5);
		const result = await runTranslate(
			{
				text: "Long text",
				targetLanguage: "German",
				rootDir,
				config: configuredGeminiAcp,
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(fullText),
			},
		);

		expect(result.truncated).toBe(true);
		expect(result.responseId).toBeTruthy();
		const stored = await getStoredResult<{ text: string }>(result.responseId ?? "", { rootDir });
		expect(stored.value.text).toBe(fullText);
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	promptText = "";

	constructor(private readonly response: string) {}

	async search(_request: GeminiAcpSearchRequest): Promise<SearchResultItem[]> {
		return [];
	}

	async prompt(request: GeminiAcpPromptRequest): Promise<string> {
		this.promptText = request.prompt;
		return this.response;
	}
}
