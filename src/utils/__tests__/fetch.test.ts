/** @file Tests for safe direct fetcher with redirect validation. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectFetcher } from "../fetch.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("DirectFetcher", () => {
	it("follows a safe redirect and re-validates the target", async () => {
		const mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);

		mockFetch.mockResolvedValueOnce({
			status: 302,
			ok: false,
			headers: {
				// oxlint-disable-next-line vitest/no-conditional-in-test -- mock Headers.get is case-insensitive
				get: (k: string) => (k.toLowerCase() === "location" ? "https://example.com/page2" : null),
			},
		});
		mockFetch.mockResolvedValueOnce({
			status: 200,
			ok: true,
			headers: {
				// oxlint-disable-next-line vitest/no-conditional-in-test -- mock Headers.get is case-insensitive
				get: (k: string) => (k.toLowerCase() === "content-type" ? "text/html" : null),
			},
			text: async () => "final content",
		});

		const result = await new DirectFetcher().fetch("https://example.com/page1");
		expect(result.text).toBe("final content");
		expect(result.url).toBe("https://example.com/page2");
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("blocks a redirect to a private IP address", async () => {
		const mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);

		mockFetch.mockResolvedValueOnce({
			status: 302,
			ok: false,
			headers: {
				// oxlint-disable-next-line vitest/no-conditional-in-test -- mock Headers.get is case-insensitive
				get: (k: string) => (k.toLowerCase() === "location" ? "http://127.0.0.1:11434/api" : null),
			},
		});

		await expect(new DirectFetcher().fetch("https://example.com/page1")).rejects.toThrow(
			"Private IPv4 source hydration is blocked",
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("blocks a redirect to localhost", async () => {
		const mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);

		mockFetch.mockResolvedValueOnce({
			status: 302,
			ok: false,
			headers: {
				// oxlint-disable-next-line vitest/no-conditional-in-test -- mock Headers.get is case-insensitive
				get: (k: string) => (k.toLowerCase() === "location" ? "http://localhost:3000/data" : null),
			},
		});

		await expect(new DirectFetcher().fetch("https://example.com/page1")).rejects.toThrow(
			"Private/local source hydration is blocked",
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("aborts when redirect hop limit is exceeded", async () => {
		const mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);

		for (let i = 0; i < 6; i += 1) {
			mockFetch.mockResolvedValueOnce({
				status: 302,
				ok: false,
				headers: {
					get: (k: string) =>
						// oxlint-disable-next-line vitest/no-conditional-in-test -- mock Headers.get is case-insensitive
						k.toLowerCase() === "location" ? `https://example.com/page${i + 2}` : null,
				},
			});
		}

		await expect(new DirectFetcher().fetch("https://example.com/page1")).rejects.toThrow(
			"redirect exceeded 5 hops",
		);
		expect(mockFetch).toHaveBeenCalledTimes(5);
	});

	it("respects maxBytes and stops reading early", async () => {
		const mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);

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
			headers: { get: () => null },
			body: stream,
		});

		const result = await new DirectFetcher().fetch("https://example.com/page1", {
			maxBytes: 100,
		});
		expect(result.text.length).toBeLessThanOrEqual(100);
		expect(result.text).toContain("A");
	});

	it("streams multiple chunks and respects maxBytes across reads", async () => {
		const mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);

		const encoder = new TextEncoder();
		let enqueueCount = 0;
		const chunks = ["Hello ", "world ", "this ", "is ", "a ", "test."];
		const stream = new ReadableStream({
			start(controller) {
				function push() {
					// oxlint-disable-next-line vitest/no-conditional-in-test -- ReadableStream controller termination
					if (enqueueCount >= chunks.length) {
						controller.close();
						return;
					}
					try {
						controller.enqueue(encoder.encode(chunks[enqueueCount]));
					} catch {
						return;
					}
					enqueueCount += 1;
					// Simulate async delivery
					setTimeout(push, 0);
				}
				push();
			},
		});

		mockFetch.mockResolvedValueOnce({
			status: 200,
			ok: true,
			headers: { get: () => null },
			body: stream,
		});

		// maxBytes set to slice in the middle of chunk 3 ("this ")
		const result = await new DirectFetcher().fetch("https://example.com/page1", {
			maxBytes: 14,
		});
		expect(result.text).toBe("Hello world th");
	});

	it("cancels the body stream after maxBytes is reached, not just releases the lock", async () => {
		const mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);

		let readsRequested = 0;
		let cancelled = false;
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			pull(controller) {
				readsRequested += 1;
				controller.enqueue(encoder.encode("x".repeat(100)));
				// If cancel() isn't called, pull keeps being invoked forever — guard with a hard cap.
				if (readsRequested > 50) controller.close();
			},
			cancel() {
				cancelled = true;
			},
		});

		mockFetch.mockResolvedValueOnce({
			status: 200,
			ok: true,
			headers: { get: () => null },
			body: stream,
		});

		const result = await new DirectFetcher().fetch("https://example.com/page1", {
			maxBytes: 50,
		});
		expect(result.text.length).toBeLessThanOrEqual(50);
		expect(cancelled).toBe(true);
		// After cancel, no further pull() invocations should happen.
		const readsAtCancel = readsRequested;
		await new Promise((r) => setTimeout(r, 10));
		expect(readsRequested).toBe(readsAtCancel);
	});
});
