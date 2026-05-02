import { describe, expect, it } from "vitest";
import {
	normalizeGeminiAcpSearchResults,
	parseSearchPayload,
} from "../client.js";

describe("Gemini ACP client parsing", () => {
	it("parses fenced JSON search payloads", () => {
		const parsed = parseSearchPayload(
			'```json\n[{"title":"Example","url":"https://example.com/?utm_source=x","snippet":"Snippet"}]\n```',
		);
		const results = normalizeGeminiAcpSearchResults(parsed);
		expect(results).toHaveLength(1);
		expect(results[0]?.normalizedUrl).toBe("https://example.com/");
	});

	it("normalizes object-wrapped result arrays", () => {
		const results = normalizeGeminiAcpSearchResults({
			results: [{ title: "A", link: "https://a.example/path/" }],
		});
		expect(results[0]?.url).toBe("https://a.example/path/");
		expect(results[0]?.ranking).toBe(1);
	});
});
