import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/settings.js";
import type { ResultEnvelope } from "../../types.js";
import type { PiCommandOptions } from "../define.js";
import {
	parseGeminiConfigCommandArgs,
	runGeminiConfig,
} from "../gemini-config.js";
import {
	getGeminiModelCompletions,
	runGeminiModelCommand,
	setGeminiModel,
} from "../gemini-model.js";
import { geminiAcpCommands, registerGeminiAcpCommands } from "../register.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-commands-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("Gemini ACP command registration", () => {
	it("registers explicit Gemini ACP configuration commands", () => {
		const registered: Array<{ name: string; options: PiCommandOptions }> = [];
		registerGeminiAcpCommands({
			registerCommand: (name, options) => {
				registered.push({ name, options });
			},
		});

		expect(registered.map((entry) => entry.name)).toEqual([
			"gemini-config",
			"gemini-model",
		]);
		expect(
			registered.every((entry) => typeof entry.options.handler === "function"),
		).toBe(true);
		expect(geminiAcpCommands.every((command) => command.parameters)).toBe(true);
		expect(
			registered.find((entry) => entry.name === "gemini-model")?.options
				.getArgumentCompletions,
		).toBe(getGeminiModelCompletions);
		expect(
			geminiAcpCommands.every((command) => command.name.startsWith("gemini-")),
		).toBe(true);
	});

	it("falls back to text model choices when UI is unavailable", async () => {
		const result = await runGeminiModelCommand({}, undefined);

		expect(result.content[0]?.text).toContain("/gemini-model <choice>");
		expect(result.content[0]?.text).toContain("gemini-3.1-pro-preview");
	});

	it("reports default Gemini ACP status when no settings are persisted and the default command is missing", async () => {
		const result = await runGeminiConfig(
			{ action: "status" },
			{ config: {}, commandExists: async () => false },
		);
		const data = (result.details as ResultEnvelope).data as {
			state?: string;
			error?: { code?: string };
		};

		expect(result.content[0]?.text).toContain("Gemini ACP needs attention");
		expect(result.content[0]?.text).toContain("Command:");
		expect(result.content[0]?.text).toContain("- settingsPersisted: no");
		expect(result.content[0]?.text).toContain("- command: gemini (default)");
		expect(result.content[0]?.text).toContain("- args: --acp (default)");
		expect(result.content[0]?.text).toContain("- executable: not found");
		expect(result.content[0]?.text).toContain("- command kind: name (default)");
		expect(result.content[0]?.text).toContain("- auth: confirmed");
		expect(result.content[0]?.text).toContain("- search grounding: available");
		expect(result.content[0]?.text).toContain("- file analysis: unknown");
		expect(result.content[0]?.text).toContain(
			"- image input: unknown (transport: unconfirmed; requires filesystem-read permission)",
		);
		expect(result.content[0]?.text).toContain(
			"Gemini ACP command is not persisted; using default `gemini --acp`, but it was not found on PATH.",
		);
		expect(data.state).toBe("command_not_found");
		expect(data.error?.code).toBe("GEMINI_ACP_COMMAND_NOT_FOUND");
	});

	it("reports ready default Gemini ACP status when no settings are persisted and the default command exists", async () => {
		const result = await runGeminiConfig(
			{ action: "status" },
			{ config: {}, commandExists: async () => true },
		);
		const data = (result.details as ResultEnvelope).data as { state?: string };

		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(data.state).toBe("ready");
		expect(result.content[0]?.text).toContain(
			"Gemini ACP is ready for Gemini-backed search/research.",
		);
		expect(result.content[0]?.text).toContain("- settingsPersisted: no");
		expect(result.content[0]?.text).toContain("- command: gemini (default)");
		expect(result.content[0]?.text).toContain("- args: --acp (default)");
		expect(result.content[0]?.text).toContain("- executable: found");
		expect(result.content[0]?.text).toContain("- command kind: name (default)");
		expect(result.content[0]?.text).toContain("- auth: confirmed");
		expect(result.content[0]?.text).toContain("- search grounding: available");
	});

	it("reports configured Gemini ACP status details", async () => {
		const result = await runGeminiConfig(
			{ action: "status" },
			{
				config: {
					providers: {
						"gemini-acp": {
							enabled: true,
							command: "/opt/homebrew/bin/gemini",
							args: ["--acp", "--model", "gemini-3-flash-preview"],
							authenticated: true,
							searchGroundingAvailable: true,
							model: "gemini-3-flash-preview",
							modelSelectionAvailable: true,
							permissionPolicy: { filesystemRead: true, reason: "review docs" },
						},
					},
				},
				commandExists: async (command) =>
					command === "/opt/homebrew/bin/gemini",
			},
		);

		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(result.content[0]?.text).toContain("- settingsPersisted: yes");
		expect(result.content[0]?.text).toContain("- command: gemini");
		expect(result.content[0]?.text).toContain(
			"- args: --acp --model gemini-3-flash-preview",
		);
		expect(result.content[0]?.text).toContain("- executable: found");
		expect(result.content[0]?.text).toContain("- auth: confirmed");
		expect(result.content[0]?.text).toContain("- search grounding: available");
		expect(result.content[0]?.text).toContain(
			"- file analysis: unknown (ACP resource-link transport",
		);
		expect(result.content[0]?.text).toContain(
			"- image input: unknown (transport: unconfirmed; requires filesystem-read permission)",
		);
		expect(result.content[0]?.text).toContain(
			"Selected model: gemini-3-flash-preview",
		);
		expect(result.content[0]?.text).toContain(
			"- permission policy: file-read: filesystem read",
		);
		expect(result.content[0]?.text).toContain("- filesystem read: enabled");
	});

	it("persists default ACP command settings", async () => {
		const result = await runGeminiConfig(
			{ action: "command" },
			{
				rootDir,
				commandExists: async (command) => command === "gemini",
				now: () => new Date("2026-01-02T03:04:05.000Z"),
			},
		);

		const config = await loadConfig({ rootDir });
		expect(result.content[0]?.text).toContain("gemini --acp");
		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect((result.details as ResultEnvelope).data).toMatchObject({
			preflight: {
				commandFound: true,
				checkedAt: "2026-01-02T03:04:05.000Z",
			},
		});
		expect(config.providers?.["gemini-acp"]).toMatchObject({
			enabled: true,
			command: "gemini",
			args: ["--acp"],
		});
	});

	it("persists custom Gemini ACP command args", async () => {
		const result = await runGeminiConfig(
			{
				action: "command",
				executable: "/usr/local/bin/gemini",
				args: ["--acp", "--model", "gemini-2.5-flash"],
			},
			{
				rootDir,
				commandExists: async (command) => command === "/usr/local/bin/gemini",
			},
		);

		const config = await loadConfig({ rootDir });
		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(config.providers?.["gemini-acp"]).toMatchObject({
			command: "/usr/local/bin/gemini",
			args: ["--acp", "--model", "gemini-2.5-flash"],
		});
	});

	it("reports a missing configured command after saving valid settings", async () => {
		const result = await runGeminiConfig(
			{ action: "command", executable: "missing-gemini", args: ["--acp"] },
			{ rootDir, commandExists: async () => false },
		);

		const config = await loadConfig({ rootDir });
		expect((result.details as ResultEnvelope).error?.code).toBe(
			"GEMINI_ACP_COMMAND_NOT_FOUND",
		);
		expect(result.content[0]?.text).toContain("Install and authenticate");
		expect(config.providers?.["gemini-acp"]).toMatchObject({
			command: "missing-gemini",
			args: ["--acp"],
		});
	});

	it("parses command and args from raw slash-command text", () => {
		expect(
			parseGeminiConfigCommandArgs(
				"command gemini --acp --model gemini-2.5-flash",
			),
		).toEqual({
			action: "command",
			executable: "gemini",
			args: ["--acp", "--model", "gemini-2.5-flash"],
		});
	});

	it("parses permissions action toggles from raw slash-command text", () => {
		expect(
			parseGeminiConfigCommandArgs(
				"permissions filesystemWrite true confirmRisk=true reason=modify docs",
			),
		).toEqual({
			action: "permissions",
			capability: "filesystemWrite",
			enabled: true,
			confirmRisk: true,
			reason: "modify docs",
		});
	});

	it("parses trust action from raw slash-command text", () => {
		expect(parseGeminiConfigCommandArgs("trust")).toEqual({
			action: "trust",
		});
	});

	it("parses recall action from raw slash-command text", () => {
		expect(parseGeminiConfigCommandArgs("recall disable")).toEqual({
			action: "recall",
			recallAction: "disable",
		});
	});

	it("adds Gemini CLI trust arg in headless config mode", async () => {
		const result = await runGeminiConfig(
			{ action: "trust" },
			{ rootDir, commandExists: async () => true },
		);

		expect(result.content[0]?.text).toContain("--skip-trust");
		expect(
			(await loadConfig({ rootDir })).providers?.["gemini-acp"],
		).toMatchObject({ command: "gemini", args: ["--acp", "--skip-trust"] });
	});

	it("refuses secret-like args instead of persisting them", async () => {
		const result = await runGeminiConfig(
			{ action: "command", executable: "gemini", args: ["--api-key=abc123"] },
			{ rootDir, commandExists: async () => true },
		);

		const config = await loadConfig({ rootDir });
		expect((result.details as ResultEnvelope).error?.code).toBe(
			"GEMINI_ACP_SECRET_ARGUMENT_REFUSED",
		);
		expect(config.providers?.["gemini-acp"]).toBeUndefined();
	});

	it("returns a Pi shell when setting a supported explicit model", async () => {
		const result = await setGeminiModel(
			{ model: "gemini-2.5-pro" },
			{
				rootDir,
				commandExists: async () => true,
				readCommandHelp: async () => "--model Model [string]",
			},
		);

		expect(result.content[0]?.text).toContain("gemini-2.5-pro");
		expect((result.details as ResultEnvelope).data).toBeTruthy();
	});

	it("lists selectable Gemini model choices when no model is provided", async () => {
		const result = await setGeminiModel({}, { rootDir });
		expect(result.content[0]?.text).toContain("/gemini-model <choice>");
		expect(result.content[0]?.text).toContain("gemini-3.1-pro-preview");
		expect((result.details as ResultEnvelope).data).toMatchObject({
			choices: expect.arrayContaining([
				expect.objectContaining({ id: "gemini-3-flash-preview" }),
				expect.objectContaining({ id: "gemini-3.1-flash-lite-preview" }),
			]),
		});
	});

	it("accepts latest model aliases from selectable choices", async () => {
		const result = await setGeminiModel(
			{ model: "pro" },
			{
				rootDir,
				commandExists: async () => true,
				readCommandHelp: async () => "--model Model [string]",
			},
		);

		expect(result.content[0]?.text).toContain("gemini-3.1-pro-preview");
		expect(
			(await loadConfig({ rootDir })).providers?.["gemini-acp"]?.model,
		).toBe("gemini-3.1-pro-preview");
	});

	it("offers slash-command completions for selectable models", () => {
		expect(getGeminiModelCompletions("pro")).toEqual([
			expect.objectContaining({ value: "gemini-3.1-pro-preview" }),
		]);
		expect(getGeminiModelCompletions("flash")).toEqual([
			expect.objectContaining({ value: "gemini-3-flash-preview" }),
			expect.objectContaining({ value: "gemini-3.1-flash-lite-preview" }),
		]);
		expect(getGeminiModelCompletions("missing-model")).toBeNull();
	});

	it("shows Gemini ACP capability settings with descriptions", async () => {
		const result = await runGeminiConfig(
			{ action: "permissions" },
			{ rootDir },
		);

		expect(result.content[0]?.text).toContain("Gemini ACP Capabilities:");
		expect(result.content[0]?.text).toContain(
			"- [ ] Filesystem read — Allow Gemini ACP to read text files from your workspace.",
		);
		expect(result.content[0]?.text).toContain(
			"Required for: file analysis, reading project docs.",
		);
		expect(result.content[0]?.text).toContain(
			"- [ ] Filesystem write — Allow Gemini ACP to write text files to your workspace. ⚠️ Requires confirmation.",
		);
		expect(result.content[0]?.text).toContain(
			"- [ ] Terminal execution — Allow Gemini ACP to execute shell commands. ⚠️ Requires confirmation.",
		);
		expect(result.content[0]?.text).toContain(
			"Current: restrictive (no capabilities enabled)",
		);
	});

	it("toggles filesystemRead without risk confirmation", async () => {
		const result = await runGeminiConfig(
			{ action: "permissions", capability: "filesystemRead" },
			{ rootDir },
		);
		const config = await loadConfig({ rootDir });

		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(result.content[0]?.text).toContain("- [x] Filesystem read");
		expect(config.providers?.["gemini-acp"]?.permissionPolicy).toMatchObject({
			filesystemRead: true,
			filesystemWrite: false,
			terminal: false,
		});
	});

	it("requires explicit confirmation before enabling filesystemWrite", async () => {
		const result = await runGeminiConfig(
			{ action: "permissions", capability: "filesystemWrite", enabled: true },
			{ rootDir },
		);
		const config = await loadConfig({ rootDir });

		expect((result.details as ResultEnvelope).error?.code).toBe(
			"GEMINI_ACP_PERMISSION_CONFIRMATION_REQUIRED",
		);
		expect(config.providers?.["gemini-acp"]?.permissionPolicy).toBeUndefined();
	});

	it("toggles filesystemWrite with risk confirmation", async () => {
		const result = await runGeminiConfig(
			{
				action: "permissions",
				capability: "filesystemWrite",
				enabled: true,
				confirmRisk: true,
				reason: "modify generated docs",
			},
			{ rootDir },
		);
		const config = await loadConfig({ rootDir });

		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(result.content[0]?.text).toContain("- [x] Filesystem write");
		expect(config.providers?.["gemini-acp"]?.permissionPolicy).toMatchObject({
			filesystemWrite: true,
			reason: "modify generated docs",
		});
	});

	it("toggles terminal with risk confirmation", async () => {
		const result = await runGeminiConfig(
			{
				action: "permissions",
				capability: "terminal",
				confirmRisk: true,
			},
			{ rootDir },
		);
		const config = await loadConfig({ rootDir });

		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(result.content[0]?.text).toContain("- [x] Terminal execution");
		expect(config.providers?.["gemini-acp"]?.permissionPolicy).toMatchObject({
			terminal: true,
		});
	});
});
