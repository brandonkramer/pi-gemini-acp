import { describe, expect, it } from "vitest";
import { canonicalJson, deriveCacheKey } from "../cache-key.js";

describe("cache-key", () => {
	it("canonicalizes object keys deterministically", () => {
		expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
			canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
		);
	});

	it("changes when model or provider settings change", () => {
		const first = deriveCacheKey({
			tool: "gemini_extract",
			inputs: { prompt: "x" },
			model: "gemini-a",
			providerSettings: { enabled: true, command: "gemini", args: ["--acp"] },
		}).cacheKey;
		const second = deriveCacheKey({
			tool: "gemini_extract",
			inputs: { prompt: "x" },
			model: "gemini-b",
			providerSettings: { enabled: true, command: "gemini", args: ["--acp"] },
		}).cacheKey;
		expect(first).not.toBe(second);
	});
});
