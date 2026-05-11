import { describe, expect, it } from "vitest";

import {
	normalizeGeminiAcpSearchResults,
	parseSearchPayload,
	permissionOptionId,
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

	it("denies ACP permission requests by default", () => {
		expect(permissionOptionId(fileReadPermission())).toBeUndefined();
	});

	it("selects allow_once only when policy allows the requested capability", () => {
		expect(permissionOptionId(fileReadPermission(), { filesystemRead: true })).toBe("allow-1");
		expect(permissionOptionId(fileWritePermission(), { filesystemRead: true })).toBeUndefined();
		expect(permissionOptionId(fileWritePermission(), { filesystemWrite: true })).toBe("allow-1");
	});

	it("denies malformed permission requests without throwing", () => {
		expect(permissionOptionId(undefined, { filesystemRead: true })).toBeUndefined();
	});
});

function fileReadPermission() {
	return {
		toolCall: { name: "read_file", arguments: { path: "/tmp/doc.txt" } },
		options: [{ kind: "allow_once", optionId: "allow-1" }],
	};
}

function fileWritePermission() {
	return {
		toolCall: { name: "write_file", arguments: { path: "/tmp/doc.txt" } },
		options: [{ kind: "allow_once", optionId: "allow-1" }],
	};
}
