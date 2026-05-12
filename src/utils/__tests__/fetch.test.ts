/** @file Tests for safe direct fetcher with redirect validation. */
import { describe, expect, it, vi } from "vitest";

import { DirectFetcher } from "../fetch.ts";

describe("DirectFetcher", () => {
	it("follows a safe redirect and re-validates the target", async () => {
		const mockFetch = vi.fn();
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		mockFetch.mockResolvedValueOnce({
			status: 302,
			ok: false,
			headers: new Map([["location", "https://example.com/page2"]]),
		});
		mockFetch.mockResolvedValueOnce({
			status: 200,
			ok: true,
			headers: new Map([["content-type", "text/html"]]),
			text: async () => "final content",
		});

		const result = await new DirectFetcher().fetch("https://example.com/page1");
		expect(result.text).toBe("final content");
		expect(result.url).toBe("https://example.com/page2");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("blocks a redirect to a private IP address", async () => {
		const mockFetch = vi.fn();
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		mockFetch.mockResolvedValueOnce({
			status: 302,
			ok: false,
			headers: new Map([["location", "http://127.0.0.1:11434/api"]]),
		});

		await expect(new DirectFetcher().fetch("https://example.com/page1")).rejects.toThrow(
			"Private IPv4 source hydration is blocked",
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("blocks a redirect to localhost", async () => {
		const mockFetch = vi.fn();
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		mockFetch.mockResolvedValueOnce({
			status: 302,
			ok: false,
			headers: new Map([["location", "http://localhost:3000/data"]]),
		});

		await expect(new DirectFetcher().fetch("https://example.com/page1")).rejects.toThrow(
			"Private/local source hydration is blocked",
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("aborts when redirect hop limit is exceeded", async () => {
		const mockFetch = vi.fn();
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		for (let i = 0; i < 6; i += 1) {
			mockFetch.mockResolvedValueOnce({
				status: 302,
				ok: false,
				headers: new Map([["location", `https://example.com/page${i + 2}`]]),
			});
		}

		await expect(new DirectFetcher().fetch("https://example.com/page1")).rejects.toThrow(
			"redirect exceeded 5 hops",
		);
		expect(mockFetch).toHaveBeenCalledTimes(5);
	});

	it("respects maxBytes and stops reading early", async () => {
		const mockFetch = vi.fn();
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const encoder = new TextEncoder();
		const bodyText = "A".repeat(10_000);
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(bodyText));
				controller.close();
			},
		});

		mockFetch.mockResolvedValueOnce({
			status: 200,
			ok: true,
			headers: new Map([["content-type", "text/plain"]]),
			body: stream,
		});

		const result = await new DirectFetcher().fetch("https://example.com/page1", {
			maxBytes: 100,
		});
		expect(result.text.length).toBeLessThanOrEqual(100);
		expect(result.text).toContain("A");
	});
});
