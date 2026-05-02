import { describe, expect, it } from "vitest";
import { runSearch } from "../../search/run.js";

const enabled = process.env.PI_GEMINI_ACP === "1";

describe.skipIf(!enabled)("opt-in Gemini ACP smoke", () => {
	it("runs configured Gemini ACP search", async () => {
		const command = process.env.PI_GEMINI_ACP_COMMAND ?? "gemini";
		const args = (process.env.PI_GEMINI_ACP_ARGS ?? "--acp")
			.split(" ")
			.filter(Boolean);
		const result = await runSearch({
			query: "official Gemini API documentation",
			maxResults: 3,
			config: {
				providers: {
					"gemini-acp": {
						enabled: true,
						command,
						args,
						authenticated: true,
						searchGroundingAvailable: true,
					},
				},
			},
		});
		expect(result.error).toBeUndefined();
		expect(result.results.length).toBeGreaterThan(0);
	}, 120_000);
});

describe.skipIf(enabled)("opt-in Gemini ACP smoke", () => {
	it("is skipped unless PI_GEMINI_ACP=1", () => {
		expect(process.env.PI_GEMINI_ACP).not.toBe("1");
	});
});
