import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeminiAcpCommandSettings } from "../client.js";
import { GeminiAcpClientCache } from "../client-cache.js";
import type { GeminiAcpProcessSession } from "../session.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("GeminiAcpClientCache", () => {
	it("reuses one initialized session for sequential searches with the same settings", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		await client.search({ query: "one", maxResults: 5 });
		await client.search({ query: "two", maxResults: 5 });

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.initializeCalls).toBe(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(1);
		expect(factory.sessions[0]?.promptCalls).toBe(2);
		await cache.close();
	});

	it("uses separate warm sessions when command settings differ", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		await cache
			.get(settings("gemini-a"))
			.search({ query: "one", maxResults: 5 });
		await cache
			.get(settings("gemini-b"))
			.search({ query: "two", maxResults: 5 });

		expect(factory.sessions).toHaveLength(2);
		await cache.close();
	});

	it("includes permission policy in the cache key", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		await cache
			.get(settings("gemini", { filesystemRead: true }))
			.search({ query: "one", maxResults: 5 });
		await cache
			.get(settings("gemini", { filesystemWrite: true }))
			.search({ query: "two", maxResults: 5 });

		expect(factory.sessions).toHaveLength(2);
		await cache.close();
	});

	it("keeps the process warm but uses separate search sessions for different cwd values", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		await client.search({ query: "one", maxResults: 5, cwd: "/tmp/one" });
		await client.search({ query: "two", maxResults: 5, cwd: "/tmp/two" });

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(2);
		expect(factory.sessions[0]?.cwds).toEqual(["/tmp/one", "/tmp/two"]);
		await cache.close();
	});

	it("uses a fresh ACP session for each prompt while keeping the process warm", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"), "prompt");

		await client.prompt({ prompt: "one" });
		await client.prompt({ prompt: "two" });

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.initializeCalls).toBe(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(2);
		expect(factory.sessions[0]?.promptCalls).toBe(2);
		await cache.close();
	});

	it("keeps search and prompt cache entries separate", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		await cache
			.get(settings("gemini"), "search")
			.search({ query: "one", maxResults: 5 });
		await cache.get(settings("gemini"), "prompt").prompt({ prompt: "two" });

		expect(factory.sessions).toHaveLength(2);
		await cache.close();
	});

	it("closes an idle warm session after the configured TTL", async () => {
		vi.useFakeTimers();
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({
			idleTtlMs: 10,
			sessionFactory: factory.create,
		});

		await cache.get(settings("gemini")).search({ query: "one", maxResults: 5 });
		expect(factory.sessions[0]?.closeCalls).toBe(0);

		await vi.advanceTimersByTimeAsync(10);

		expect(factory.sessions[0]?.closeCalls).toBe(1);
		await cache.close();
	});

	it("invalidates a failed warm session so the next search starts fresh", async () => {
		const factory = new FakeSessionFactory({ failFirstPrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		await expect(
			client.search({ query: "fail", maxResults: 5 }),
		).rejects.toThrow("planned failure");
		await cache.get(settings("gemini")).search({ query: "ok", maxResults: 5 });

		expect(factory.sessions).toHaveLength(2);
		expect(factory.sessions[0]?.closeCalls).toBe(1);
		expect(factory.sessions[1]?.promptCalls).toBe(1);
		await cache.close();
	});

	it("surfaces mid-prompt aborts as AbortError and invalidates the session", async () => {
		const factory = new FakeSessionFactory({ waitForClosePrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const controller = new AbortController();
		const client = cache.get(settings("gemini"));

		const aborted = client.search(
			{ query: "slow", maxResults: 5 },
			controller.signal,
		);
		await factory.waitForPromptStart();
		controller.abort();

		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(factory.sessions[0]?.closeCalls).toBe(1);

		await cache.get(settings("gemini")).search({ query: "ok", maxResults: 5 });
		expect(factory.sessions).toHaveLength(2);
		await cache.close();
	});

	it("stale close calls do not evict a replacement cache entry", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const first = cache.get(settings("gemini"));

		await first.search({ query: "one", maxResults: 5 });
		await (first as typeof first & { close(): Promise<void> }).close();
		const second = cache.get(settings("gemini"));
		await (first as typeof first & { close(): Promise<void> }).close();

		expect(cache.get(settings("gemini"))).toBe(second);
		await cache.close();
	});

	it("serializes prompt turns on a warm session", async () => {
		const factory = new FakeSessionFactory({ delayedPrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		const first = client.search({ query: "one", maxResults: 5 });
		const second = client.search({ query: "two", maxResults: 5 });
		await Promise.all([first, second]);

		expect(factory.sessions[0]?.maxConcurrentPrompts).toBe(1);
		await cache.close();
	});
});

function settings(
	command: string,
	permissionPolicy?: GeminiAcpCommandSettings["permissionPolicy"],
): GeminiAcpCommandSettings {
	return { command, args: ["--acp"], permissionPolicy };
}

class FakeSessionFactory {
	readonly sessions: FakeSession[] = [];
	private promptFailuresRemaining: number;
	private waitForClosePromptsRemaining: number;

	constructor(
		private readonly options: {
			failFirstPrompt?: boolean;
			delayedPrompt?: boolean;
			waitForClosePrompt?: boolean;
		} = {},
	) {
		this.promptFailuresRemaining = options.failFirstPrompt ? 1 : 0;
		this.waitForClosePromptsRemaining = options.waitForClosePrompt ? 1 : 0;
	}

	create = async (): Promise<GeminiAcpProcessSession> => {
		const session = new FakeSession(this);
		this.sessions.push(session);
		return session;
	};

	shouldFailPrompt(): boolean {
		if (this.promptFailuresRemaining <= 0) return false;
		this.promptFailuresRemaining -= 1;
		return true;
	}

	shouldDelayPrompt(): boolean {
		return this.options.delayedPrompt === true;
	}

	shouldWaitForClosePrompt(): boolean {
		if (this.waitForClosePromptsRemaining <= 0) return false;
		this.waitForClosePromptsRemaining -= 1;
		return true;
	}

	waitForPromptStart(): Promise<void> {
		if (this.promptStarted) return Promise.resolve();
		return new Promise((resolve) => {
			this.promptStartResolver = resolve;
		});
	}

	recordPromptStart(): void {
		this.promptStarted = true;
		this.promptStartResolver?.();
		this.promptStartResolver = undefined;
	}

	private promptStarted = false;
	private promptStartResolver?: () => void;
}

class FakeSession implements GeminiAcpProcessSession {
	initializeCalls = 0;
	newSessionCalls = 0;
	promptCalls = 0;
	closeCalls = 0;
	maxConcurrentPrompts = 0;
	readonly cwds: string[] = [];
	private activePrompts = 0;
	private closePromptReject?: (error: Error) => void;

	constructor(private readonly factory: FakeSessionFactory) {}

	async initialize(): Promise<void> {
		this.initializeCalls += 1;
	}

	async newSession(cwd: string): Promise<string> {
		this.newSessionCalls += 1;
		this.cwds.push(cwd);
		return `session-${this.newSessionCalls}`;
	}

	async prompt(): Promise<string> {
		this.promptCalls += 1;
		if (this.factory.shouldFailPrompt()) throw new Error("planned failure");
		this.activePrompts += 1;
		this.maxConcurrentPrompts = Math.max(
			this.maxConcurrentPrompts,
			this.activePrompts,
		);
		try {
			if (this.factory.shouldDelayPrompt()) await Promise.resolve();
			if (this.factory.shouldWaitForClosePrompt()) {
				await new Promise<never>((_, reject) => {
					this.closePromptReject = reject;
					this.factory.recordPromptStart();
				});
			}
			this.factory.recordPromptStart();
			return JSON.stringify([
				{
					title: "Result",
					url: `https://example.com/${this.promptCalls}`,
					snippet: "snippet",
				},
			]);
		} finally {
			this.activePrompts -= 1;
		}
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
		this.closePromptReject?.(new Error("closed"));
	}
}
