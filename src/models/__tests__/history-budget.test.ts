import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_HISTORY_CHARS, fitHistory, maxHistoryChars } from "../history-budget.ts";

describe("fitHistory", () => {
	it("returns the history unchanged within budget", () => {
		const entries = [
			{ role: "user" as const, text: "User: hi" },
			{ role: "assistant" as const, text: "Assistant: hello" },
		];
		expect(fitHistory(entries, 1000)).toEqual(["User: hi", "Assistant: hello"]);
	});

	it("shortens older tool results first and keeps the current exchange intact", () => {
		const big = "x".repeat(10_000);
		const entries = [
			{ role: "user" as const, text: "User: old" },
			{ role: "toolResult" as const, text: `Tool (bash): ${big}` },
			{ role: "user" as const, text: "User: now" },
			{ role: "toolResult" as const, text: `Tool (read): ${big}` },
		];
		const result = fitHistory(entries, 15_000);
		expect(result).toHaveLength(4);
		expect(result[1].length).toBeLessThan(2_200);
		expect(result[1]).toContain("characters of older tool output omitted");
		expect(result[3]).toBe(entries[3].text);
	});

	it("drops the oldest messages when shortening is not enough, never the latest", () => {
		const entries = [
			{ role: "user" as const, text: "a".repeat(600) },
			{ role: "assistant" as const, text: "b".repeat(600) },
			{ role: "user" as const, text: "c".repeat(600) },
		];
		expect(fitHistory(entries, 700)).toEqual([
			"[2 earlier messages omitted to stay within chat.maxHistoryChars]",
			"c".repeat(600),
		]);
		expect(fitHistory(entries.slice(2), 10)).toEqual(["c".repeat(600)]);
	});
});

describe("maxHistoryChars", () => {
	it("uses the default, a positive override, or no limit for 0", () => {
		expect(maxHistoryChars(undefined)).toBe(DEFAULT_MAX_HISTORY_CHARS);
		expect(maxHistoryChars(5000.7)).toBe(5000);
		expect(maxHistoryChars(0)).toBe(Number.POSITIVE_INFINITY);
	});
});
