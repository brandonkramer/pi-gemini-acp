/** @file Tests for Gemini ACP search prewarm scheduling and status. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptRequest,
} from "../../acp/client.ts";
import { saveGeminiAcpSettings } from "../../config/settings.ts";
import type { SearchResultItem } from "../../types.ts";
import {
	__resetGeminiSearchPrewarmStatus,
	getGeminiSearchPrewarmStatus,
	prewarmGeminiSearchClient,
	scheduleGeminiSearchPrewarm,
} from "../prewarm.ts";
import { __resetGeminiSearchPreflightCache, runSearch } from "../run.ts";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-prewarm-"));
});

afterEach(async () => {
	__resetGeminiSearchPreflightCache();
	__resetGeminiSearchPrewarmStatus();
	await rm(rootDir, { recursive: true, force: true });
});

describe("Gemini search prewarm", () => {
	it("short-circuits when PI_GEMINI_ACP_NO_PREWARM is enabled", async () => {
		let loaded = false;
		let warmed = false;

		const result = await prewarmGeminiSearchClient(
			{ env: { PI_GEMINI_ACP_NO_PREWARM: "1" } },
			{
				loadConfig: async () => {
					loaded = true;
					return {};
				},
				warmSearchClient: async () => {
					warmed = true;
				},
			},
		);

		expect(result).toMatchObject({
			attempted: false,
			warmed: false,
			skippedReason: "disabled",
		});
		expect(loaded).toBe(false);
		expect(warmed).toBe(false);
		expect(getGeminiSearchPrewarmStatus()).toMatchObject({
			state: "disabled",
			attempted: false,
			warmed: false,
		});
	});

	it("populates the search preflight cache before the first user search", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: false,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);
		let commandChecks = 0;
		let authProbes = 0;
		let warmedSettings: GeminiAcpCommandSettings | undefined;
		const deps = {
			commandExists: async () => {
				commandChecks += 1;
				return true;
			},
			authProbe: async () => {
				authProbes += 1;
				return { authenticated: true };
			},
		};

		const prewarm = await prewarmGeminiSearchClient(
			{ rootDir },
			{
				...deps,
				warmSearchClient: async (settings) => {
					warmedSettings = settings;
				},
			},
		);
		const result = await runSearch(
			{ query: "after-prewarm", rootDir },
			{ ...deps, geminiAcpClient: new FakeGeminiClient() },
		);

		expect(prewarm).toMatchObject({ attempted: true, warmed: true });
		expect(getGeminiSearchPrewarmStatus()).toMatchObject({
			state: "warmed",
			attempted: true,
			warmed: true,
		});
		expect(warmedSettings?.command).toBe("gemini");
		expect(result.error).toBeUndefined();
		expect(commandChecks).toBe(1);
		expect(authProbes).toBe(1);
	});

	it("does not cache transient preflight failures", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				authenticated: true,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);
		let commandChecks = 0;

		const prewarm = await prewarmGeminiSearchClient(
			{ rootDir },
			{
				commandExists: async () => {
					commandChecks += 1;
					return false;
				},
			},
		);
		const result = await runSearch(
			{ query: "after-failed-prewarm", rootDir },
			{
				commandExists: async () => {
					commandChecks += 1;
					return true;
				},
				geminiAcpClient: new FakeGeminiClient(),
			},
		);

		expect(prewarm).toMatchObject({
			attempted: true,
			warmed: false,
			skippedReason: "preflight",
		});
		expect(result.error).toBeUndefined();
		expect(commandChecks).toBe(2);
	});

	it("survives warm client startup failures", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				authenticated: true,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);

		const result = await prewarmGeminiSearchClient(
			{ rootDir },
			{
				commandExists: async () => true,
				warmSearchClient: async () => {
					throw new Error("planned warm failure");
				},
			},
		);

		expect(result).toMatchObject({
			attempted: true,
			warmed: false,
			skippedReason: "failed",
		});
		expect(result.cause).toBeInstanceOf(Error);
	});

	it("schedules prewarm after activation without running inline", () => {
		let scheduled: (() => void) | undefined;
		let unrefCalls = 0;

		scheduleGeminiSearchPrewarm(
			{ env: {} },
			{
				schedule: (callback) => {
					scheduled = callback;
					return {
						unref: () => {
							unrefCalls += 1;
						},
					};
				},
			},
		);

		expect(typeof scheduled).toBe("function");
		expect(unrefCalls).toBe(1);
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	async prompt(request: GeminiAcpPromptRequest): Promise<string> {
		return request.prompt ?? "";
	}

	async search(): Promise<SearchResultItem[]> {
		return [
			{
				title: "Gemini",
				url: "https://example.com/g",
				normalizedUrl: "https://example.com/g",
				snippet: "g",
				ranking: 1,
				source: {
					provider: "gemini-acp",
					kind: "gemini-acp",
					requiresCloud: false,
					requiresApiKey: false,
					requiresLocalAuth: true,
				},
			},
		];
	}
}
