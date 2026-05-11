/** @file Tests for warm Gemini ACP client process and search-session caching. */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	DEFAULT_IDLE_TTL_MS,
	defaultGeminiAcpIdleTtlMs,
	GeminiAcpClientCache,
} from "../client-cache.ts";
import type { GeminiAcpCommandSettings } from "../client.ts";
import type { GeminiAcpProcessSession, GeminiAcpPromptOptions } from "../session.ts";

const originalCwd = process.cwd();

afterEach(() => {
	process.chdir(originalCwd);
	vi.useRealTimers();
	vi.unstubAllEnvs();
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

		await cache.get(settings("gemini-a")).search({ query: "one", maxResults: 5 });
		await cache.get(settings("gemini-b")).search({ query: "two", maxResults: 5 });

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

	it("reuses one neutral search session across caller cwd changes", async () => {
		const cwdRoot = await mkdtemp(path.join(tmpdir(), "pi-gemini-cwd-"));
		const cwdOne = await mkdtemp(path.join(cwdRoot, "one-"));
		const cwdTwo = await mkdtemp(path.join(cwdRoot, "two-"));
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));
		try {
			process.chdir(cwdOne);
			await client.search({ query: "one", maxResults: 5 });
			process.chdir(cwdTwo);
			await client.search({ query: "two", maxResults: 5 });

			expect(factory.sessions).toHaveLength(1);
			expect(factory.sessions[0]?.newSessionCalls).toBe(1);
			expect(factory.sessions[0]?.cwds).toEqual([homedir() || cwdOne]);
		} finally {
			process.chdir(originalCwd);
			await cache.close();
			await rm(cwdRoot, { recursive: true, force: true });
		}
	});

	it("keeps the process warm but uses separate search sessions for explicit cwd values", async () => {
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

	it("pre-warms the default search session without prompting", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		await cache.warmSearch(settings("gemini"));
		await cache.get(settings("gemini")).search({ query: "one", maxResults: 5 });

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.initializeCalls).toBe(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(1);
		expect(factory.sessions[0]?.promptCalls).toBe(1);
		expect(factory.sessions[0]?.cwds).toEqual([homedir() || originalCwd]);
		await cache.close();
	});

	it("reports warm-process and search-session progress states", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));
		const messages: string[] = [];
		const onProgress = (_phase: string, message: string) => messages.push(message);

		await client.search({ query: "one", maxResults: 4, onProgress });
		await client.search({ query: "two", maxResults: 4, onProgress });

		expect(messages).toEqual(
			expect.arrayContaining([
				"Started ACP process (Gemini ACP).",
				'Creating new search session for "one" (4 results).',
				expect.stringContaining("● Waiting for Gemini backend..."),
				"Using existing warm ACP process (Gemini ACP).",
				'Reusing warm search session for "two" (4 results).',
			]),
		);
		await cache.close();
	});

	it("uses a fresh caller-cwd ACP session for each prompt while keeping the process warm", async () => {
		const cwdRoot = await mkdtemp(path.join(tmpdir(), "pi-gemini-prompt-cwd-"));
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"), "prompt");
		try {
			process.chdir(cwdRoot);
			const callerCwd = process.cwd();
			await client.prompt({ prompt: "one" });
			await client.prompt({ prompt: "two" });

			expect(factory.sessions).toHaveLength(1);
			expect(factory.sessions[0]?.initializeCalls).toBe(1);
			expect(factory.sessions[0]?.newSessionCalls).toBe(2);
			expect(factory.sessions[0]?.promptCalls).toBe(2);
			expect(factory.sessions[0]?.cwds).toEqual([callerCwd, callerCwd]);
		} finally {
			process.chdir(originalCwd);
			await cache.close();
			await rm(cwdRoot, { recursive: true, force: true });
		}
	});

	it("passes prompt AbortSignal into fresh cached prompt sessions", async () => {
		const factory = new FakeSessionFactory({ waitForClosePrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const controller = new AbortController();
		const client = cache.get(settings("gemini"), "prompt");

		const aborted = client.prompt({ prompt: "slow" }, controller.signal);
		await factory.waitForPromptStart();
		controller.abort();

		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(factory.sessions[0]?.promptSignals).toEqual([controller.signal]);
		expect(factory.sessions[0]?.closeCalls).toBe(1);

		await cache.get(settings("gemini"), "prompt").prompt({ prompt: "ok" });
		expect(factory.sessions).toHaveLength(2);
		await cache.close();
	});

	it("keeps search and prompt cache entries separate", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		await cache.get(settings("gemini"), "search").search({ query: "one", maxResults: 5 });
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

	it("uses a 15 minute default idle TTL", () => {
		expect(DEFAULT_IDLE_TTL_MS).toBe(900_000);
		expect(defaultGeminiAcpIdleTtlMs({})).toBe(900_000);
	});

	it("uses PI_GEMINI_ACP_IDLE_TTL_MS for fresh cache instances", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_GEMINI_ACP_IDLE_TTL_MS", "50");
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		await cache.get(settings("gemini")).search({ query: "one", maxResults: 5 });
		await vi.advanceTimersByTimeAsync(49);
		expect(factory.sessions[0]?.closeCalls).toBe(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(factory.sessions[0]?.closeCalls).toBe(1);
		await cache.close();
	});

	it("falls back to the default idle TTL for invalid env overrides", () => {
		expect(defaultGeminiAcpIdleTtlMs({ PI_GEMINI_ACP_IDLE_TTL_MS: "abc" })).toBe(
			DEFAULT_IDLE_TTL_MS,
		);
		expect(defaultGeminiAcpIdleTtlMs({ PI_GEMINI_ACP_IDLE_TTL_MS: "0" })).toBe(DEFAULT_IDLE_TTL_MS);
		expect(defaultGeminiAcpIdleTtlMs({ PI_GEMINI_ACP_IDLE_TTL_MS: "-1" })).toBe(
			DEFAULT_IDLE_TTL_MS,
		);
	});

	it("lets constructor idleTtlMs override the env TTL", async () => {
		vi.useFakeTimers();
		vi.stubEnv("PI_GEMINI_ACP_IDLE_TTL_MS", "1000");
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({
			idleTtlMs: 10,
			sessionFactory: factory.create,
		});

		await cache.get(settings("gemini")).search({ query: "one", maxResults: 5 });
		await vi.advanceTimersByTimeAsync(10);

		expect(factory.sessions[0]?.closeCalls).toBe(1);
		await cache.close();
	});

	it("invalidates a failed warm session so the next search starts fresh", async () => {
		const factory = new FakeSessionFactory({ failFirstPrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		await expect(client.search({ query: "fail", maxResults: 5 })).rejects.toThrow(
			"planned failure",
		);
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

		const aborted = client.search({ query: "slow", maxResults: 5 }, controller.signal);
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

	it("serializes concurrent search turns by default", async () => {
		const factory = new FakeSessionFactory({ delayedPrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		const first = client.search({ query: "one", maxResults: 5 });
		const second = client.search({ query: "two", maxResults: 5 });
		await Promise.all([first, second]);

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(1);
		expect(factory.sessions[0]?.maxConcurrentPrompts).toBe(1);
		await cache.close();
	});

	it("allows parallel search turns when explicitly enabled", async () => {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH_PARALLEL", "1");
		const factory = new FakeSessionFactory({ delayedPrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		const first = client.search({ query: "one", maxResults: 5 });
		const second = client.search({ query: "two", maxResults: 5 });
		await Promise.all([first, second]);

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(2);
		expect(factory.sessions[0]?.maxConcurrentPrompts).toBe(2);
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
	readonly promptSignals: Array<AbortSignal | undefined> = [];
	private activePrompts = 0;
	private closePromptReject?: (error: Error) => void;

	constructor(private readonly factory: FakeSessionFactory) {}

	async initialize() {
		this.initializeCalls += 1;
		return {
			promptCapabilities: {
				embeddedContext: true,
				image: false,
				audio: false,
			},
		};
	}

	async newSession(cwd: string): Promise<string> {
		this.newSessionCalls += 1;
		this.cwds.push(cwd);
		return `session-${this.newSessionCalls}`;
	}

	async prompt(
		_sessionId?: string,
		_prompt?: unknown,
		_onUpdate?: unknown,
		options?: GeminiAcpPromptOptions,
	): Promise<string> {
		this.promptSignals.push(options?.signal);
		this.promptCalls += 1;
		if (this.factory.shouldFailPrompt()) throw new Error("planned failure");
		this.activePrompts += 1;
		this.maxConcurrentPrompts = Math.max(this.maxConcurrentPrompts, this.activePrompts);
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
