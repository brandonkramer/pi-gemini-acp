import { describe, expect, it } from "vitest";

import { buildRecallText } from "../recall-text.ts";

describe("buildRecallText", () => {
	it("is deterministic for equivalent object inputs", () => {
		const first = buildRecallText({
			tool: "gemini_extract",
			inputs: { b: "second", a: "first" },
			result: { text: "done", timing: { durationMs: 1 } },
		});
		const second = buildRecallText({
			tool: "gemini_extract",
			inputs: { a: "first", b: "second" },
			result: { timing: { durationMs: 2 }, text: "done" },
		});

		expect(first).toBe(second);
		expect(first).toContain("tool: gemini_extract");
		expect(first).not.toContain("durationMs");
	});
});
