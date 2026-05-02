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
import { getGeminiModelCompletions, setGeminiModel } from "../gemini-model.js";
import { setGeminiPermissions } from "../gemini-permissions.js";
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
			"gemini-permissions",
		]);
		expect(
			registered.every((entry) => typeof entry.options.handler === "function"),
		).toBe(true);
		expect(
			registered.every((entry) => entry.options.parameters !== undefined),
		).toBe(true);
		expect(
			registered.find((entry) => entry.name === "gemini-model")?.options
				.getArgumentCompletions,
		).toBe(getGeminiModelCompletions);
		expect(
			geminiAcpCommands.every((command) => command.name.startsWith("gemini-")),
		).toBe(true);
	});

	it("reports read-only Gemini ACP status with remediation", async () => {
		const result = await runGeminiConfig(
			{ action: "status" },
			{ config: {}, commandExists: async () => false },
		);

		expect(result.content[0]?.text).toContain("Gemini ACP needs attention");
		expect(result.content[0]?.text).toContain("Command:");
		expect(result.content[0]?.text).toContain("- command: unset");
		expect(result.content[0]?.text).toContain("- executable: unknown");
		expect(result.content[0]?.text).toContain("- auth: unknown");
		expect(result.content[0]?.text).toContain("- search grounding: unknown");
		expect(result.content[0]?.text).toContain("- file analysis: unknown");
		expect(result.content[0]?.text).toContain(
			"- image input: unknown (transport: unconfirmed)",
		);
		expect(result.content[0]?.text).toContain(
			"- permission policy: restrictive",
		);
		expect(result.content[0]?.text).toContain("Future ACP capability flags:");
		expect(result.content[0]?.text).toContain("Remediation:");
		expect(
			((result.details as ResultEnvelope).data as { error?: { code?: string } })
				.error?.code,
		).toBe("GEMINI_ACP_MISSING_CONFIG");
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
							permissionPolicy: { mode: "file-read", reason: "review docs" },
						},
					},
				},
				commandExists: async (command) =>
					command === "/opt/homebrew/bin/gemini",
			},
		);

		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(result.content[0]?.text).toContain("- command: gemini");
		expect(result.content[0]?.text).toContain(
			"- args: --acp --model gemini-3-flash-preview",
		);
		expect(result.content[0]?.text).toContain("- executable: found");
		expect(result.content[0]?.text).toContain("- auth: confirmed");
		expect(result.content[0]?.text).toContain("- search grounding: available");
		expect(result.content[0]?.text).toContain(
			"- file analysis: unknown (tool returns unsupported",
		);
		expect(result.content[0]?.text).toContain(
			"- image input: unknown (transport: unconfirmed)",
		);
		expect(result.content[0]?.text).toContain(
			"Selected model: gemini-3-flash-preview",
		);
		expect(result.content[0]?.text).toContain(
			"- permission policy: file-read: filesystem read",
		);
		expect(result.content[0]?.text).toContain("- filesystem read: enabled");
	});

	it("persists default Gemini ACP command settings", async () => {
		const result = await runGeminiConfig(
			{ action: "persist" },
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
				action: "persist",
				command: "/usr/local/bin/gemini",
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
			{ action: "persist", command: "missing-gemini", args: ["--acp"] },
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
				"persist gemini --acp --model gemini-2.5-flash",
			),
		).toEqual({
			action: "persist",
			command: "gemini",
			args: ["--acp", "--model", "gemini-2.5-flash"],
		});
	});

	it("refuses secret-like args instead of persisting them", async () => {
		const result = await runGeminiConfig(
			{ action: "persist", command: "gemini", args: ["--api-key=abc123"] },
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

	it("persists restrictive policy without risk confirmation", async () => {
		const result = await setGeminiPermissions(
			{ mode: "restrictive" },
			{ rootDir },
		);
		const config = await loadConfig({ rootDir });
		expect((result.details as ResultEnvelope).error).toBeUndefined();
		expect(config.providers?.["gemini-acp"]?.permissionPolicy?.mode).toBe(
			"restrictive",
		);
	});

	it("requires explicit confirmation before persisting broader policy", async () => {
		const result = await setGeminiPermissions(
			{ mode: "file-read" },
			{ rootDir },
		);
		const config = await loadConfig({ rootDir });
		expect((result.details as ResultEnvelope).error?.code).toBe(
			"GEMINI_ACP_PERMISSION_CONFIRMATION_REQUIRED",
		);
		expect(config.providers?.["gemini-acp"]?.permissionPolicy).toBeUndefined();
	});

	it("persists explicitly confirmed broader policy", async () => {
		const result = await setGeminiPermissions(
			{ mode: "file-read", confirmRisk: true, reason: "analyze docs" },
			{ rootDir },
		);
		const config = await loadConfig({ rootDir });
		expect((result.details as ResultEnvelope).data).toMatchObject({
			summary: "file-read: filesystem read",
		});
		expect(config.providers?.["gemini-acp"]?.permissionPolicy).toMatchObject({
			mode: "file-read",
			reason: "analyze docs",
		});
	});
});
