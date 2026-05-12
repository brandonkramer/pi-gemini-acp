/** @file Tests for GeminiApiKeyClient defensive checks and fallback behavior. */
import { describe, expect, it, vi } from "vitest";

import { GeminiApiKeyClient } from "../client.ts";

describe("GeminiApiKeyClient", () => {
	it("throws on prompt request containing resource_link parts", async () => {
		const client = new GeminiApiKeyClient({
			config: { providers: { "gemini-acp": { apiKey: "test-key-fake" } } },
			fetch: () => {
				throw new Error("fetch should not be called");
			},
		});

		await expect(
			client.prompt({
				parts: [
					{ type: "text", text: "Analyze:" },
					{ type: "resource_link", uri: "file:///etc/passwd", name: "passwd" },
				],
			}),
		).rejects.toThrow(/GEMINI_API_KEY_UNSUPPORTED_TRANSPORT/u);
	});

	it("accepts plain text prompt requests", async () => {
		const client = new GeminiApiKeyClient({
			config: { providers: { "gemini-acp": { apiKey: "test-key-fake" } } },
			fetch: async () =>
				({
					ok: true,
					json: async () => ({
						candidates: [{ content: { parts: [{ text: "ok" }] } }],
					}),
				}) as Response,
		});

		const result = await client.prompt({ prompt: "Hello" });
		expect(result).toBe("ok");
	});

	it("builds a single-prefix URL for plain model ids", async () => {
		const calls: string[] = [];
		const mockFetch = vi.fn(async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				json: async () => ({
					candidates: [{ content: { parts: [{ text: "ok" }] } }],
				}),
			} as unknown as Response;
		});

		const client = new GeminiApiKeyClient({
			config: { providers: { "gemini-acp": { apiKey: "test-key" } } },
			fetch: mockFetch as unknown as typeof fetch,
			model: "gemini-2.5-flash",
		});

		await client.prompt({ prompt: "hi" });
		expect(calls[0]).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
		expect(calls[0]).not.toContain("/models/models/");
	});

	it("strips a leading 'models/' from the configured model id", async () => {
		const calls: string[] = [];
		const mockFetch = vi.fn(async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				json: async () => ({
					candidates: [{ content: { parts: [{ text: "ok" }] } }],
				}),
			} as unknown as Response;
		});

		const client = new GeminiApiKeyClient({
			config: { providers: { "gemini-acp": { apiKey: "test-key" } } },
			fetch: mockFetch as unknown as typeof fetch,
			model: "models/gemini-2.5-flash",
		});

		await client.prompt({ prompt: "hi" });
		expect(calls[0]).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
		expect(calls[0]).not.toContain("/models/models/");
	});
});
