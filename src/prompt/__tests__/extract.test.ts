import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	GeminiAcpClient,
	GeminiAcpPromptRequest,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpSearchRequest,
} from "../../acp/client.ts";
import { getStoredResult } from "../../storage/results.ts";
import type { SearchResultItem } from "../../types.ts";
import { runExtract } from "../extract.ts";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-extract-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runExtract", () => {
	it("returns structured data from supplied content", async () => {
		const client = new FakeGeminiClient('{"name":"Ada","age":37}');
		const updates: Array<{ phase?: string; text: string; request?: unknown }> = [];
		const result = await runExtract(
			{
				content: "Name: Ada. Age: 37.",
				prompt: "Extract a person record.",
				schema: personSchema,
				rootDir,
				config: {},
			},
			{ commandExists: async () => true, geminiAcpClient: client },
			undefined,
			(update) => {
				updates.push({
					phase: progressPhase(update),
					text: update.text,
					request: progressRequest(update),
				});
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.extracted).toEqual({ name: "Ada", age: 37 });
		expect(client.promptText).toContain("Name: Ada. Age: 37.");
		expect(client.promptText).toContain("Extract a person record.");
		const providerPrompt = updates.find((update) => update.phase === "provider_prompt");
		expect(providerPrompt?.text).toContain('Sending extraction prompt: "Extract a person record."');
		expect(providerPrompt?.text).toContain("contentLength 19");
		expect(providerPrompt?.text).toContain("schema object");
		expect(providerPrompt?.text).not.toContain("Name: Ada");
		expect(providerPrompt?.request).toMatchObject({
			toolName: "gemini_extract",
			arguments: expect.objectContaining({ contentLength: 19 }),
		});
	});

	it("parses fenced JSON responses", async () => {
		const result = await runExtract(
			{
				content: "Ada Lovelace",
				prompt: "Extract a person record.",
				schema: personSchema,
				rootDir,
				config: {},
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient('```json\n{"name":"Ada","age":37}\n```'),
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.extracted).toEqual({ name: "Ada", age: 37 });
	});

	it("returns structured parse errors and stores raw invalid output", async () => {
		const result = await runExtract(
			{
				content: "Ada Lovelace",
				prompt: "Extract a person record.",
				schema: personSchema,
				rootDir,
				config: {},
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient("not json"),
			},
		);

		expect(result.error).toMatchObject({
			code: "GEMINI_EXTRACT_INVALID_JSON",
			phase: "response_parse",
		});
		expect(result.responseId).toBeTruthy();
		const stored = await getStoredResult<{
			rawText: string;
			error: { code: string };
		}>(result.responseId!, { rootDir });
		expect(stored.value.rawText).toBe("not json");
		expect(stored.value.error.code).toBe("GEMINI_EXTRACT_INVALID_JSON");
	});

	it("normalizes camelCase and snake_case metadata variants when surfaced", async () => {
		const snake = await runExtract(
			{
				content: "metadata",
				prompt: "Extract metadata.",
				schema: metadataSchema,
				rootDir,
				config: {},
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(
					'{"value":"ok","provider_metadata":{"provider":"gemini-acp","model_name":"gemini-3","response_id":"abc"}}',
				),
			},
		);
		const camel = await runExtract(
			{
				content: "metadata",
				prompt: "Extract metadata.",
				schema: metadataSchema,
				rootDir,
				config: {},
			},
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient(
					'{"value":"ok","providerMetadata":{"provider":"gemini-acp","modelName":"gemini-3","responseId":"def"}}',
				),
			},
		);

		expect(snake.metadata).toMatchObject({
			provider: "gemini-acp",
			modelName: "gemini-3",
			responseId: "abc",
		});
		expect(camel.metadata).toMatchObject({
			provider: "gemini-acp",
			modelName: "gemini-3",
			responseId: "def",
		});
	});

	it("rejects unsupported schemas deterministically before provider execution", async () => {
		const client = new FakeGeminiClient('{"name":"Ada"}');
		const result = await runExtract(
			{
				content: "Ada Lovelace",
				prompt: "Extract a person record.",
				schema: { $ref: "#/defs/person" },
				rootDir,
				config: {},
			},
			{ commandExists: async () => true, geminiAcpClient: client },
		);

		expect(result.error?.code).toBe("GEMINI_EXTRACT_UNSUPPORTED_SCHEMA");
		expect(client.promptText).toBe("");
	});
});

const personSchema = {
	type: "object",
	properties: {
		name: { type: "string" },
		age: { type: "integer" },
	},
	required: ["name"],
	additionalProperties: false,
};

const metadataSchema = {
	type: "object",
	properties: {
		value: { type: "string" },
		provider_metadata: { type: "object" },
		providerMetadata: { type: "object" },
	},
	required: ["value"],
};

class FakeGeminiClient implements GeminiAcpClient {
	promptText = "";

	constructor(private readonly response: string) {}

	async search(_request: GeminiAcpSearchRequest): Promise<SearchResultItem[]> {
		return [];
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		_signal?: AbortSignal,
		_onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		this.promptText = request.prompt ?? "";
		return this.response;
	}
}

function progressPhase(update: { type: string; phase?: string }): string | undefined {
	return update.type === "progress" ? update.phase : undefined;
}

function progressRequest(update: { type: string; request?: unknown }): unknown {
	return update.type === "progress" ? update.request : undefined;
}
