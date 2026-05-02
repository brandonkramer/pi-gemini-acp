import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveGeminiAcpSettings } from "../../config/settings.js";
import type { ResultEnvelope } from "../../types.js";
import {
	buildGeminiLoginHelp,
	runGeminiLoginHelp,
} from "../gemini-login-help.js";
import { geminiAcpCommands, registerGeminiAcpCommands } from "../register.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-login-help-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("gemini login help command", () => {
	it("registers the read-only login help command", () => {
		const registered: string[] = [];
		registerGeminiAcpCommands({
			registerCommand: (name) => {
				registered.push(name);
			},
		});
		expect(geminiAcpCommands.map((command) => command.name)).toContain(
			"gemini-login-help",
		);
		expect(registered).toContain("gemini-login-help");
	});

	it("explains remediation without requiring configured Gemini ACP", () => {
		const help = buildGeminiLoginHelp();
		expect(help.text).toContain("Configured ACP command: not configured yet");
		expect(help.text).toContain("GEMINI_ACP_MISSING_CONFIG");
		expect(help.text).toContain("GEMINI_ACP_UNAUTHENTICATED");
		expect(help.text).toContain("GEMINI_ACP_SEARCH_UNAVAILABLE");
		expect(help.data.mutatesConfig).toBe(false);
		expect(help.data.runsAuthFlow).toBe(false);
	});

	it("loads configured command details and redacts sensitive arguments", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "/Users/alice/bin/gemini",
				args: ["--acp", "--api-key", "secret-token", "--project=demo"],
			},
			{ rootDir },
		);

		const result = await runGeminiLoginHelp(
			{ statusCode: "GEMINI_ACP_UNAUTHENTICATED" },
			{ rootDir },
		);
		const details = result.details as ResultEnvelope;

		expect(result.content[0]?.text).toContain(
			"Configured ACP command: gemini --acp --api-key [redacted] --project=demo",
		);
		expect(result.content[0]?.text).toContain(
			"Focused remediation for GEMINI_ACP_UNAUTHENTICATED",
		);
		expect(result.content[0]?.text).not.toContain("secret-token");
		expect(details.data).toMatchObject({
			configured: true,
			mutatesConfig: false,
			runsAuthFlow: false,
		});
	});
});
