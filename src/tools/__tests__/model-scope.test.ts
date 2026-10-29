import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSearchEnabled } from "../../config/settings.ts";
import { isGeminiModel, registerGeminiToolModelScope } from "../model-scope.ts";

let rootDir: string;
beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "gemini-model-scope-"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(rootDir, { recursive: true, force: true });
});

type Handler = (...args: unknown[]) => void;

function fakePi(initial: string[]) {
	let active = initial;
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, active: () => active };
}

describe("Gemini tool model scope", () => {
	it("recognizes Gemini through different providers", () => {
		expect(isGeminiModel({ provider: "gemini-acp", id: "custom" })).toBe(true);
		expect(isGeminiModel({ provider: "google", id: "gemini-2.5-pro" })).toBe(true);
		expect(isGeminiModel({ provider: "openrouter", id: "google/gemini-2.5-pro" })).toBe(true);
		expect(isGeminiModel({ provider: "anthropic", id: "claude-sonnet" })).toBe(false);
		expect(isGeminiModel(undefined)).toBe(false);
	});

	it("hides and restores Gemini tools without changing unrelated tools", () => {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH", "0");
		const { pi, handlers, active } = fakePi([
			"read",
			"other_search",
			"gemini_search",
			"gemini_ask",
			"gemini_status",
		]);
		registerGeminiToolModelScope(pi, { rootDir });
		handlers.get("session_start")!({}, { model: { provider: "anthropic", id: "claude" } });
		expect(active()).toEqual(["read", "other_search"]);
		handlers.get("model_select")!({ model: { provider: "google", id: "gemini-2.5-pro" } });
		expect(active()).toEqual(["read", "other_search", "gemini_ask", "gemini_status"]);
		handlers.get("model_select")!({ model: { provider: "openai", id: "gpt-5" } });
		expect(active()).toEqual(["read", "other_search"]);
	});

	it("follows the saved search setting before the next request", async () => {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH", "");
		const { pi, handlers, active } = fakePi(["gemini_search", "gemini_ask"]);
		registerGeminiToolModelScope(pi, { rootDir });
		const ctx = { model: { provider: "gemini-acp", id: "gemini-auto" } };
		handlers.get("session_start")!({}, ctx);
		expect(active()).toEqual(["gemini_search", "gemini_ask"]);
		await saveSearchEnabled(false, { rootDir });
		handlers.get("before_agent_start")!({}, ctx);
		expect(active()).toEqual(["gemini_ask"]);
		await saveSearchEnabled(true, { rootDir });
		handlers.get("before_agent_start")!({}, ctx);
		expect(active()).toEqual(["gemini_ask", "gemini_search"]);
	});
});
