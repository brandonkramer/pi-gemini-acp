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
import type { GeminiAcpCommandSettings, GeminiAcpConversation } from "../client.ts";
import { JsonRpcTransportError } from "../jsonrpc-stdio.ts";
import type { GeminiAcpProcessSession, GeminiAcpPromptOptions } from "../session.ts";

const originalCwd = process.cwd();
const OVERFLOW_MESSAGE =
	"The input token count exceeds the maximum number of tokens allowed 1048576.";

afterEach(() => {
	process.chdir(originalCwd);
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("GeminiAcpClientCache", () => {
	it("closes the subprocess while initialize is still waiting for a response", async () => {
		let rejectInitialize!: (error: Error) => void;
		let started!: () => void;
		const initializing = new Promise<void>((resolve) => {
			started = resolve;
		});
		const session = {
			initialize: vi.fn(() => {
				started();
				return new Promise<never>((_resolve, reject) => {
					rejectInitialize = reject;
				});
			}),
			newSession: vi.fn(),
			prompt: vi.fn(),
			close: vi.fn(async () => {
				rejectInitialize(new Error("closed during initialize"));
			}),
		};
		const cache = new GeminiAcpClientCache({ sessionFactory: async () => session });
		const warm = cache.warmSearch(settings("gemini"));
		const outcome = warm.catch((error: unknown) => error);
		await initializing;
		await cache.close();
		expect(await outcome).toEqual(new Error("closed during initialize"));
		expect(session.close).toHaveBeenCalled();
		expect(session.newSession).not.toHaveBeenCalled();
	});

	it("cancels a queued prompt without waiting for or cancelling the active turn", async () => {
		const factory = new FakeSessionFactory({ waitForClosePrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"), "prompt");
		const active = new AbortController();
		const first = client.prompt({ prompt: "active" }, active.signal);
		const firstOutcome = first.catch((error: unknown) => error);
		await factory.waitForPromptStart();
		const queued = new AbortController();
		const second = client.prompt({ prompt: "must not run" }, queued.signal);
		queued.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(active.signal.aborted).toBe(false);
		expect(factory.sessions[0]?.promptCalls).toBe(1);
		active.abort();
		await firstOutcome;
		await client.prompt({ prompt: "next" });
		expect(factory.sessions[0]?.promptCalls).toBe(2);
		await cache.close();
	});

	it("cancels startup and evicts the abandoned process", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let rejectInitialize!: (error: Error) => void;
		const session = {
			initialize: vi.fn(() => {
				entered();
				return new Promise<never>((_resolve, reject) => {
					rejectInitialize = reject;
				});
			}),
			newSession: vi.fn(),
			prompt: vi.fn(),
			close: vi.fn(async () => {
				rejectInitialize(new Error("closed"));
			}),
		};
		const cache = new GeminiAcpClientCache({ sessionFactory: async () => session });
		const client = cache.get(settings("gemini"));
		const controller = new AbortController();
		const request = client.prompt({ prompt: "cancel" }, controller.signal);
		await started;
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(cache.get(settings("gemini"))).not.toBe(client);
		expect(session.newSession).not.toHaveBeenCalled();
		await cache.close();
		expect(session.close).toHaveBeenCalled();
	});

	it("cancels session creation and never submits the cancelled prompt", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let finish!: (id: string) => void;
		const factory = new FakeSessionFactory();
		const session = await factory.create();
		const prompt = vi.spyOn(session, "prompt");
		vi.spyOn(session, "newSession").mockImplementationOnce(() => {
			entered();
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		});
		const cache = new GeminiAcpClientCache({ sessionFactory: async () => session });
		const client = cache.get(settings("gemini"));
		const controller = new AbortController();
		const request = client.prompt({ prompt: "cancel" }, controller.signal);
		await started;
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		finish("abandoned-session");
		await client.prompt({ prompt: "next" });
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).not.toBe("abandoned-session");
		await cache.close();
	});

	it("evicts a failed transport instead of retrying a prompt on it", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));
		await client.prompt({ prompt: "warm" });
		vi.spyOn(factory.sessions[0], "prompt").mockRejectedValueOnce(
			new JsonRpcTransportError("exited"),
		);
		await expect(client.prompt({ prompt: "fail" })).rejects.toThrow("exited");
		await cache.get(settings("gemini")).prompt({ prompt: "recover" });
		expect(factory.sessions).toHaveLength(2);
		expect(factory.sessions[0]?.closeCalls).toBe(1);
		await cache.close();
	});

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
			expect(factory.sessions[0]?.cwds).toEqual([homedir()]);
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
		expect(factory.sessions[0]?.cwds).toEqual([homedir()]);
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
				expect.stringContaining(
					"● Querying Gemini search; awaiting grounded results (backend + web grounding + first-token latency)...",
				),
				"Using existing warm ACP process (Gemini ACP).",
				'Reusing warm search session for "two" (4 results).',
			]),
		);
		await cache.close();
	});

	it("uses a fresh caller-cwd session per full-history prompt while keeping the process warm", async () => {
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
			expect(factory.sessions[0]?.promptSessionIds).toEqual(["session-1", "session-2"]);
			expect(factory.sessions[0]?.cwds).toEqual([callerCwd, callerCwd]);
		} finally {
			process.chdir(originalCwd);
			await cache.close();
			await rm(cwdRoot, { recursive: true, force: true });
		}
	});

	it("restarts the warm process after the prompt-session limit so conversations do not pile up", async () => {
		vi.stubEnv("PI_GEMINI_ACP_MAX_PROMPT_SESSIONS", "2");
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"), "prompt");
		await client.prompt({ prompt: "one" });
		expect(factory.sessions[0]?.closeCalls).toBe(0);
		await client.prompt({ prompt: "two" });
		expect(factory.sessions[0]?.closeCalls).toBe(1);
		await client.prompt({ prompt: "three" });
		expect(factory.sessions).toHaveLength(2);
		expect(factory.sessions[1]?.promptCalls).toBe(1);
		await cache.close();
	});

	it("consumes a prewarmed prompt conversation only once", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"), "prompt") as ReturnType<typeof cache.get> & {
			warmPromptSession(cwd: string): Promise<void>;
		};
		await client.warmPromptSession(originalCwd);
		expect(factory.sessions[0]?.newSessionCalls).toBe(1);
		await client.prompt({ prompt: "first" });
		expect(factory.sessions[0]?.newSessionCalls).toBe(1);
		await client.prompt({ prompt: "second" });
		expect(factory.sessions[0]?.newSessionCalls).toBe(2);
		expect(factory.sessions[0]?.promptSessionIds).toEqual(["session-1", "session-2"]);
		await cache.close();
	});

	it("does not reuse successful or failed prompt sessions", async () => {
		const factory = new FakeSessionFactory({ failPromptAfterCount: 1 });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"), "prompt");
		await client.prompt({ prompt: "ok" });
		await expect(client.prompt({ prompt: "fail" })).rejects.toThrow("planned failure");
		// After eviction the next prompt creates a new session in the same warm process.
		await client.prompt({ prompt: "recover" });
		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(3);
		expect(factory.sessions[0]?.promptCalls).toBe(3);
		expect(factory.sessions[0]?.closeCalls).toBe(0);
		await cache.close();
	});

	describe("chat conversations", () => {
		/** A turn whose history is `transcript`; the fake session answers `reply`. */
		const turn = (transcript: string[], contextKey = "ctx") => {
			const conversation: GeminiAcpConversation = {
				contextKey,
				transcript,
				continuationParts: (from) =>
					transcript.slice(from).map((text) => ({ type: "text" as const, text: `new:${text}` })),
				replyFingerprint: () => "reply",
			};
			return {
				parts: transcript.map((text) => ({ type: "text" as const, text: `full:${text}` })),
				cwd: originalCwd,
				conversation,
			};
		};

		it("continues the session that holds the earlier messages and sends only new ones", async () => {
			const factory = new FakeSessionFactory();
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await client.prompt(turn(["u1"]));
			await client.prompt(turn(["u1", "reply", "u2"]));
			await client.prompt(turn(["u1", "reply", "u2", "reply", "tool", "u3"]));
			const session = factory.sessions[0];
			expect(session?.newSessionCalls).toBe(1);
			expect(session?.promptSessionIds).toEqual(["session-1", "session-1", "session-1"]);
			expect(session?.prompts).toEqual([
				[{ type: "text", text: "full:u1" }],
				[{ type: "text", text: "new:u2" }],
				[
					{ type: "text", text: "new:tool" },
					{ type: "text", text: "new:u3" },
				],
			]);
			await cache.close();
		});

		it("starts a fresh session after a branch switch or a context change", async () => {
			const factory = new FakeSessionFactory();
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await client.prompt(turn(["u1"]));
			await client.prompt(turn(["other", "reply", "u2"]));
			await client.prompt(turn(["other", "reply", "u2", "reply", "u3"], "new-context"));
			expect(factory.sessions[0]?.promptSessionIds).toEqual([
				"session-1",
				"session-2",
				"session-3",
			]);
			expect(factory.sessions[0]?.prompts[2]).toEqual([
				{ type: "text", text: "full:other" },
				{ type: "text", text: "full:reply" },
				{ type: "text", text: "full:u2" },
				{ type: "text", text: "full:reply" },
				{ type: "text", text: "full:u3" },
			]);
			// The first conversation is still continuable from its own branch.
			await client.prompt(turn(["u1", "reply", "u4"]));
			expect(factory.sessions[0]?.promptSessionIds.at(-1)).toBe("session-1");
			await cache.close();
		});

		it("does not continue a session whose turn failed", async () => {
			const factory = new FakeSessionFactory({ failPromptAfterCount: 1 });
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await client.prompt(turn(["u1"]));
			await expect(client.prompt(turn(["u1", "reply", "u2"]))).rejects.toThrow("planned failure");
			await client.prompt(turn(["u1", "reply", "u2"]));
			expect(factory.sessions[0]?.promptSessionIds).toEqual([
				"session-1",
				"session-1",
				"session-2",
			]);
			await cache.close();
		});

		it("starts a fresh session once the continued one reported too many input tokens", async () => {
			const factory = new FakeSessionFactory({ inputTokens: [1_000, 700_000, 2_000] });
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await client.prompt(turn(["u1"]));
			await client.prompt(turn(["u1", "reply", "u2"]));
			await client.prompt(turn(["u1", "reply", "u2", "reply", "u3"]));
			const session = factory.sessions[0];
			expect(session?.promptSessionIds).toEqual(["session-1", "session-1", "session-2"]);
			expect(session?.prompts[2]).toEqual(
				["u1", "reply", "u2", "reply", "u3"].map((text) => ({
					type: "text",
					text: `full:${text}`,
				})),
			);
			await cache.close();
		});

		it("honours PI_GEMINI_ACP_MAX_SESSION_INPUT_TOKENS", async () => {
			vi.stubEnv("PI_GEMINI_ACP_MAX_SESSION_INPUT_TOKENS", "500");
			const factory = new FakeSessionFactory({ inputTokens: [1_000, 1_000] });
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await client.prompt(turn(["u1"]));
			await client.prompt(turn(["u1", "reply", "u2"]));
			expect(factory.sessions[0]?.promptSessionIds).toEqual(["session-1", "session-2"]);
			await cache.close();
		});

		it("retries a continued turn on a fresh session when Gemini reports a context overflow", async () => {
			const factory = new FakeSessionFactory({
				failPromptAfterCount: 1,
				promptError: new Error(OVERFLOW_MESSAGE),
			});
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await client.prompt(turn(["u1"]));
			await client.prompt(turn(["u1", "reply", "u2"]));
			const session = factory.sessions[0];
			expect(session?.promptSessionIds).toEqual(["session-1", "session-1", "session-2"]);
			expect(session?.prompts[2]).toEqual([
				{ type: "text", text: "full:u1" },
				{ type: "text", text: "full:reply" },
				{ type: "text", text: "full:u2" },
			]);
			await cache.close();
		});

		it("does not retry an overflow after Gemini already produced output", async () => {
			const factory = new FakeSessionFactory({
				failPromptAfterCount: 1,
				promptError: new Error(OVERFLOW_MESSAGE),
				updateBeforeFailure: true,
			});
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await client.prompt(turn(["u1"]));
			await expect(client.prompt(turn(["u1", "reply", "u2"]))).rejects.toThrow(
				"input token count exceeds",
			);
			expect(factory.sessions[0]?.promptCalls).toBe(2);
			await cache.close();
		});

		it("does not retry an overflow on a fresh session", async () => {
			const factory = new FakeSessionFactory({
				failFirstPrompt: true,
				promptError: new Error(OVERFLOW_MESSAGE),
			});
			const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
			const client = cache.get(settings("gemini"), "prompt");
			await expect(client.prompt(turn(["u1"]))).rejects.toThrow("input token count exceeds");
			expect(factory.sessions[0]?.promptCalls).toBe(1);
			await cache.close();
		});
	});

	it("passes prompt AbortSignal into fresh cached prompt sessions without closing the warm process", async () => {
		const factory = new FakeSessionFactory({ waitForClosePrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const controller = new AbortController();
		const client = cache.get(settings("gemini"), "prompt");

		const aborted = client.prompt({ prompt: "slow" }, controller.signal);
		await factory.waitForPromptStart();
		controller.abort();

		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(factory.sessions[0]?.promptSignals).toEqual([controller.signal]);
		expect(factory.sessions[0]?.closeCalls).toBe(0);

		await cache.get(settings("gemini"), "prompt").prompt({ prompt: "ok" });
		expect(factory.sessions).toHaveLength(1);
		await cache.close();
	});

	it("passes parts through cached prompt when provided", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"), "prompt");

		await client.prompt({
			prompt: "",
			parts: [
				{ type: "text", text: "preamble" },
				{ type: "text", text: "user message" },
			],
		});

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.promptCalls).toBe(1);
		// FakeSession ignores prompt content, but the call path exercised parts
		await cache.close();
	});

	it("shares one warm process for search and prompt while keeping separate ACP sessions", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		await cache.get(settings("gemini"), "search").search({ query: "one", maxResults: 5 });
		await cache.get(settings("gemini"), "prompt").prompt({ prompt: "two" });

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.newSessionCalls).toBe(2);
		expect(factory.sessions[0]?.cwds).toEqual([homedir(), originalCwd]);
		expect(factory.sessions[0]?.promptCalls).toBe(2);
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

	it("reuses the warm process after a search error and retries on a fresh session", async () => {
		const factory = new FakeSessionFactory({ failFirstPrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		await expect(client.search({ query: "fail", maxResults: 5 })).rejects.toThrow(
			"planned failure",
		);
		await cache.get(settings("gemini")).search({ query: "ok", maxResults: 5 });

		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.closeCalls).toBe(0);
		expect(factory.sessions[0]?.promptCalls).toBe(2);
		await cache.close();
	});

	it("does not close the warm process when a search is aborted", async () => {
		const factory = new FakeSessionFactory();
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));

		// Warm the process first
		await client.search({ query: "warm", maxResults: 5 });
		expect(factory.sessions).toHaveLength(1);
		expect(factory.sessions[0]?.closeCalls).toBe(0);

		// Abort before the next search starts
		const controller = new AbortController();
		controller.abort();
		const aborted = client.search({ query: "slow", maxResults: 5 }, controller.signal);

		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(factory.sessions[0]?.closeCalls).toBe(0);
		expect(factory.sessions).toHaveLength(1);

		// Next search reuses the warm process
		await client.search({ query: "ok", maxResults: 5 });
		expect(factory.sessions).toHaveLength(1);
		await cache.close();
	});

	it("passes caller abort into in-flight search prompts without closing the warm process", async () => {
		const factory = new FakeSessionFactory({ waitForClosePrompt: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));
		const controller = new AbortController();

		const aborted = client.search({ query: "slow", maxResults: 5 }, controller.signal);
		await factory.waitForPromptStart();
		controller.abort();

		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(factory.sessions[0]?.promptSignals[0]?.aborted).toBe(true);
		expect(factory.sessions[0]?.closeCalls).toBe(0);

		await client.search({ query: "ok", maxResults: 5 });
		expect(factory.sessions).toHaveLength(1);
		await cache.close();
	});

	it("rejects caller-aborted search prompts when ACP resolves partial text on abort", async () => {
		const factory = new FakeSessionFactory({
			resolvePromptOnAbort: true,
			waitForClosePrompt: true,
		});
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings("gemini"));
		const controller = new AbortController();

		const aborted = client.search({ query: "slow", maxResults: 5 }, controller.signal);
		await factory.waitForPromptStart();
		controller.abort();

		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(factory.sessions[0]?.promptSignals[0]).not.toBe(controller.signal);
		expect(factory.sessions[0]?.promptSignals[0]?.aborted).toBe(true);
		expect(factory.sessions[0]?.closeCalls).toBe(0);

		await client.search({ query: "ok", maxResults: 5 });
		expect(factory.sessions).toHaveLength(1);
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

	it("serializes concurrent search turns when parallel is disabled", async () => {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH_PARALLEL", "0");
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

	it("allows parallel search turns by default", async () => {
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
	private promptSuccessesRemaining: number;
	private promptFailuresRemaining: number;
	private waitForClosePromptsRemaining: number;

	constructor(
		private readonly options: {
			failFirstPrompt?: boolean;
			failPromptAfterCount?: number;
			/** Error thrown by the planned failure instead of "planned failure". */
			promptError?: Error;
			/** Stream a chunk before the planned failure, as if Gemini had started answering. */
			updateBeforeFailure?: boolean;
			/** Input tokens reported for each successful prompt, in order. */
			inputTokens?: number[];
			delayedPrompt?: boolean;
			resolvePromptOnAbort?: boolean;
			waitForClosePrompt?: boolean;
		} = {},
	) {
		this.promptSuccessesRemaining = options.failPromptAfterCount ?? 0;
		this.promptFailuresRemaining =
			options.failPromptAfterCount !== undefined ? 1 : options.failFirstPrompt ? 1 : 0;
		this.waitForClosePromptsRemaining = options.waitForClosePrompt ? 1 : 0;
	}

	plannedFailure(): Error {
		return this.options.promptError ?? new Error("planned failure");
	}

	updateBeforeFailure(): boolean {
		return this.options.updateBeforeFailure === true;
	}

	nextInputTokens(): number | undefined {
		return this.options.inputTokens?.shift();
	}

	create = async (): Promise<GeminiAcpProcessSession> => {
		const session = new FakeSession(this);
		this.sessions.push(session);
		return session;
	};

	shouldFailPrompt(): boolean {
		if (this.promptSuccessesRemaining > 0) {
			this.promptSuccessesRemaining -= 1;
			return false;
		}
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

	shouldResolvePromptOnAbort(): boolean {
		return this.options.resolvePromptOnAbort === true;
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
	readonly promptSessionIds: Array<string | undefined> = [];
	readonly prompts: unknown[] = [];
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
		this.promptSessionIds.push(_sessionId);
		this.prompts.push(_prompt);
		this.promptSignals.push(options?.signal);
		this.promptCalls += 1;
		if (this.factory.shouldFailPrompt()) {
			if (this.factory.updateBeforeFailure() && typeof _onUpdate === "function") {
				await _onUpdate({ type: "chunk", text: "partial", accumulatedText: "partial" });
			}
			throw this.factory.plannedFailure();
		}
		const inputTokens = this.factory.nextInputTokens();
		if (inputTokens !== undefined) {
			options?.onOutcome?.({
				stopReason: "end_turn",
				usage: { inputTokens, outputTokens: 1, models: [] },
			});
		}
		this.activePrompts += 1;
		this.maxConcurrentPrompts = Math.max(this.maxConcurrentPrompts, this.activePrompts);
		try {
			if (this.factory.shouldDelayPrompt()) await Promise.resolve();
			if (this.factory.shouldWaitForClosePrompt()) {
				const abortText = await new Promise<string | undefined>((resolve, reject) => {
					this.closePromptReject = reject;
					this.factory.recordPromptStart();
					const abort = () => {
						if (this.factory.shouldResolvePromptOnAbort()) {
							resolve(
								JSON.stringify([
									{
										title: "Partial",
										url: "https://example.com/partial",
										snippet: "partial",
									},
								]),
							);
							return;
						}
						reject(new DOMException("FakeSession prompt aborted", "AbortError"));
					};
					if (options?.signal?.aborted) {
						abort();
						return;
					}
					options?.signal?.addEventListener("abort", abort, { once: true });
				});
				if (abortText) return abortText;
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
