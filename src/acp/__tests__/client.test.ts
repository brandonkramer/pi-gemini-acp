import { describe, expect, it } from "vitest";

import {
	normalizeGeminiAcpSearchResults,
	parseSearchPayload,
	permissionOptionId,
} from "../client.ts";

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

	it("uses ACP kind rather than words in diff contents or command arguments", () => {
		const options = [{ kind: "allow_once", optionId: "allow-1" }];
		expect(
			permissionOptionId(
				{ toolCall: { kind: "edit", content: [{ newText: "execute shell command" }] }, options },
				{ filesystemWrite: true },
			),
		).toBe("allow-1");
		expect(
			permissionOptionId(
				{ toolCall: { kind: "execute", title: "read file" }, options },
				{ filesystemRead: true },
			),
		).toBeUndefined();
		expect(permissionOptionId({ toolCall: { kind: "execute" }, options }, { terminal: true })).toBe(
			"allow-1",
		);
		expect(
			permissionOptionId(
				{ toolCall: { kind: "other", title: "read file" }, options },
				{ filesystemRead: true },
			),
		).toBeUndefined();
	});

	it("maps ACP kind fetch, and legacy fetch tool names, to the webFetch capability", () => {
		const options = [{ kind: "allow_once", optionId: "allow-1" }];
		const fetch = { toolCall: { kind: "fetch", title: "https://example.com" }, options };
		expect(
			permissionOptionId(fetch, { filesystemRead: true, filesystemWrite: true, terminal: true }),
		).toBeUndefined();
		expect(permissionOptionId(fetch, { webFetch: true })).toBe("allow-1");
		expect(
			permissionOptionId({ toolCall: { name: "web_fetch" }, options }, { webFetch: true }),
		).toBe("allow-1");
	});

	it("denies malformed options and unknown tool requests", () => {
		expect(
			permissionOptionId(
				{ toolCall: { kind: "read" }, options: [null, { kind: "allow_once", optionId: 42 }] },
				{ filesystemRead: true },
			),
		).toBeUndefined();
		expect(
			permissionOptionId(
				{ toolCall: { kind: "mcp" }, options: [{ kind: "allow_once", optionId: "allow-1" }] },
				{ filesystemRead: true, filesystemWrite: true, terminal: true },
			),
		).toBeUndefined();
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
