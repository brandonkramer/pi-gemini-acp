import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPiPreamble, type PiToolsSource } from "../preamble.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(path.resolve(tmpdir(), "pi-gemini-acp-preamble-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function agentsFile(): string {
	return `${cwd.replace(/\/+$/, "")}/AGENTS.md`;
}

function opts(
	overrides?: Partial<Parameters<typeof buildPiPreamble>[0]>,
): Parameters<typeof buildPiPreamble>[0] {
	return {
		modelId: "gemini-3.1-pro-preview",
		cwd,
		appendSystemPrompt: true,
		appendAgents: true,
		appendTools: true,
		pi: {},
		...overrides,
	};
}

describe("buildPiPreamble", () => {
	it("returns empty string when all flags are false", async () => {
		const result = await buildPiPreamble(
			opts({ appendSystemPrompt: false, appendAgents: false, appendTools: false }),
		);
		expect(result).toBe("");
	});

	it("passes upstreamSystemPrompt through even when all preamble flags are false", async () => {
		const result = await buildPiPreamble(
			opts({
				appendSystemPrompt: false,
				appendAgents: false,
				appendTools: false,
				upstreamSystemPrompt: "Be concise",
			}),
		);
		expect(result).toBe("Be concise");
	});

	it("appendSystemPrompt only — output starts with Pi/Model/Cwd block", async () => {
		const result = await buildPiPreamble(opts({ appendAgents: false, appendTools: false }));
		expect(result).toContain("You are running inside Pi");
		expect(result).toContain("Model: gemini-3.1-pro-preview");
		expect(result).toContain(`Working directory: ${cwd}`);
		expect(result).not.toContain("AGENTS.md");
		expect(result).not.toContain("Available tools");
	});

	it("upstreamSystemPrompt appears between Pi-header and AGENTS.md", async () => {
		await writeFile(agentsFile(), "# Test Project\nRole: tester", "utf8");
		const result = await buildPiPreamble(
			opts({ upstreamSystemPrompt: "Be helpful", appendTools: false }),
		);
		const headerIdx = result.indexOf("You are running inside Pi");
		const upstreamIdx = result.indexOf("Be helpful");
		const agentsIdx = result.indexOf("AGENTS.md");
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(upstreamIdx).toBeGreaterThan(headerIdx);
		expect(agentsIdx).toBeGreaterThan(upstreamIdx);
	});

	it("appendAgents with AGENTS.md present — section appears with content", async () => {
		await writeFile(agentsFile(), "# Test Project\nRole: tester", "utf8");
		const result = await buildPiPreamble(opts({ appendSystemPrompt: false, appendTools: false }));
		expect(result).toContain("## Project context (AGENTS.md)");
		expect(result).toContain("# Test Project");
		expect(result).toContain("Role: tester");
	});

	it("appendAgents without AGENTS.md — section absent", async () => {
		const result = await buildPiPreamble(opts({ appendSystemPrompt: false, appendTools: false }));
		expect(result).not.toContain("AGENTS.md");
	});

	it("appendAgents with 100KB AGENTS.md — content truncated", async () => {
		const huge = "A".repeat(100_000);
		await writeFile(agentsFile(), huge, "utf8");
		const result = await buildPiPreamble(opts({ appendSystemPrompt: false, appendTools: false }));
		expect(result).toContain("## Project context (AGENTS.md)");
		expect(result).toContain("[truncated]");
		expect(result.length).toBeLessThan(huge.length);
	});

	it("appendTools with getActiveTools — section lists them", async () => {
		const pi: PiToolsSource = { getActiveTools: () => ["read", "write", "bash"] };
		const result = await buildPiPreamble(
			opts({ appendSystemPrompt: false, appendAgents: false, pi }),
		);
		expect(result).toContain("## Available tools");
		expect(result).toContain("- read");
		expect(result).toContain("- write");
		expect(result).toContain("- bash");
	});

	it("appendTools with getAllTools — section lists them", async () => {
		const pi: PiToolsSource = {
			getAllTools: () => [{ name: "search" }, { name: "gemini_status" }],
		};
		const result = await buildPiPreamble(
			opts({ appendSystemPrompt: false, appendAgents: false, pi }),
		);
		expect(result).toContain("## Available tools");
		expect(result).toContain("- search");
		expect(result).toContain("- gemini_status");
	});

	it("appendTools with no skills — section absent", async () => {
		const result = await buildPiPreamble(opts({ appendSystemPrompt: false, appendAgents: false }));
		expect(result).not.toContain("Available tools");
	});
});
