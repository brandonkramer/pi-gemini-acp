/**
 * @fileoverview Tests for optional Gemini ACP search stream early-stop behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	GeminiAcpCommandSettings,
	GeminiAcpPromptPart,
	GeminiAcpPromptUpdateHandler,
} from "../client.js";
import { GeminiAcpClientCache } from "../client-cache.js";
import type {
	GeminiAcpProcessSession,
	GeminiAcpPromptOptions,
} from "../session.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Gemini ACP search early stop", () => {
	it("waits for turn end by default after a complete top-level JSON array", async () => {
		const factory = new FakeSessionFactory({
			chunks: [
				'[{"title":"Early","url":"https://example.com/early","snippet":"done"}]',
				" trailing text that should not be needed",
			],
		});
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		const results = await cache
			.get(settings())
			.search({ query: "early", maxResults: 5 });

		expect(results[0]?.title).toBe("Early");
		expect(factory.session?.emittedChunks).toBe(2);
		expect(factory.session?.earlyAbortSignals).toBe(0);
		expect(factory.session?.closeCalls).toBe(0);
		await cache.close();
	});

	it("waits for turn end when streamed search JSON is incomplete", async () => {
		const factory = new FakeSessionFactory({
			chunks: ['[{"title":"Late","url":"https://example.com/late"'],
			naturalText:
				'[{"title":"Late","url":"https://example.com/late","snippet":"done"}]',
		});
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		const results = await cache
			.get(settings())
			.search({ query: "late", maxResults: 5 });

		expect(results[0]?.title).toBe("Late");
		expect(factory.session?.emittedChunks).toBe(1);
		expect(factory.session?.earlyAbortSignals).toBe(0);
		expect(factory.session?.closeCalls).toBe(0);
		await cache.close();
	});

	it("keeps the warm process reusable when search early-stop is enabled", async () => {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH_EARLY_STOP", "1");
		const factory = new FakeSessionFactory({
			chunks: [
				'[{"title":"Reusable","url":"https://example.com/reuse","snippet":"done"}]',
				" trailing text",
			],
		});
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const client = cache.get(settings());

		await client.search({ query: "first", maxResults: 5 });
		await client.search({ query: "second", maxResults: 5 });

		expect(factory.session?.initializeCalls).toBe(1);
		expect(factory.session?.newSessionCalls).toBe(1);
		expect(factory.session?.promptCalls).toBe(2);
		expect(factory.session?.earlyAbortSignals).toBe(2);
		expect(factory.session?.closeCalls).toBe(0);
		await cache.close();
	});

	it("does not treat brackets inside JSON strings as array completion", async () => {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH_EARLY_STOP", "1");
		const factory = new FakeSessionFactory({
			chunks: [
				'[{"title":"Bracket ] ',
				'still string","url":"https://example.com/string","snippet":"done"}]',
			],
		});
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		const results = await cache
			.get(settings())
			.search({ query: "string", maxResults: 5 });

		expect(results[0]?.title).toBe("Bracket ] still string");
		expect(factory.session?.emittedChunks).toBe(2);
		expect(factory.session?.earlyAbortSignals).toBe(1);
	});

	it("propagates caller abort as AbortError instead of early-stop success", async () => {
		const factory = new FakeSessionFactory({ waitForClose: true });
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });
		const controller = new AbortController();

		const search = cache
			.get(settings())
			.search({ query: "slow", maxResults: 5 }, controller.signal);
		await factory.waitForPromptStart();
		controller.abort();

		await expect(search).rejects.toMatchObject({ name: "AbortError" });
		expect(factory.session?.closeCalls).toBe(1);
	});

	it("enables streamed search cancellation via environment opt-in", async () => {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH_EARLY_STOP", "1");
		const factory = new FakeSessionFactory({
			chunks: [
				'[{"title":"Baseline","url":"https://example.com/base","snippet":"done"}]',
				" trailing text",
			],
		});
		const cache = new GeminiAcpClientCache({ sessionFactory: factory.create });

		const results = await cache
			.get(settings())
			.search({ query: "baseline", maxResults: 5 });

		expect(results[0]?.title).toBe("Baseline");
		expect(factory.session?.emittedChunks).toBe(1);
		expect(factory.session?.earlyAbortSignals).toBe(1);
		expect(factory.session?.closeCalls).toBe(0);
		await cache.close();
	});
});

function settings(): GeminiAcpCommandSettings {
	return { command: "gemini", args: ["--acp"] };
}

class FakeSessionFactory {
	session?: FakeSession;
	private promptStarted = false;
	private promptStartResolver?: () => void;

	constructor(
		readonly options: {
			chunks?: string[];
			naturalText?: string;
			waitForClose?: boolean;
		},
	) {}

	create = async (): Promise<GeminiAcpProcessSession> => {
		this.session = new FakeSession(this);
		return this.session;
	};

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
}

class FakeSession implements GeminiAcpProcessSession {
	initializeCalls = 0;
	newSessionCalls = 0;
	promptCalls = 0;
	closeCalls = 0;
	emittedChunks = 0;
	earlyAbortSignals = 0;
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

	async newSession(): Promise<string> {
		this.newSessionCalls += 1;
		return `session-${this.newSessionCalls}`;
	}

	async prompt(
		_sessionId: string,
		_prompt: string | GeminiAcpPromptPart[],
		onUpdate?: GeminiAcpPromptUpdateHandler,
		options?: GeminiAcpPromptOptions,
	): Promise<string> {
		this.promptCalls += 1;
		this.factory.recordPromptStart();
		if (this.factory.options.waitForClose) {
			await new Promise<never>((_, reject) => {
				this.closePromptReject = reject;
			});
		}
		let accumulatedText = "";
		for (const text of this.factory.options.chunks ?? []) {
			accumulatedText += text;
			this.emittedChunks += 1;
			await onUpdate?.({ type: "chunk", text, accumulatedText });
			if (options?.signal?.aborted) {
				this.earlyAbortSignals += 1;
				return accumulatedText.trim();
			}
		}
		return this.factory.options.naturalText ?? accumulatedText.trim();
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
		this.closePromptReject?.(new Error("closed"));
	}
}
