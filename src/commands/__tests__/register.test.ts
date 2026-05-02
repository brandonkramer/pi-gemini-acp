import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveGeminiAcpSettings } from "../../config/settings.js";
import type { ResultEnvelope } from "../../types.js";
import type { GeminiCommand } from "../define.js";
import { setGeminiModel } from "../gemini-set-model.js";
import { setGeminiPermissionPolicy } from "../gemini-set-permission-policy.js";
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
		const registered: GeminiCommand[] = [];
		registerGeminiAcpCommands({
			registerCommand: (command) => registered.push(command),
		});

		expect(registered.map((command) => command.name)).toEqual([
			"gemini-login-help",
			"gemini-set-model",
			"gemini-set-permission-policy",
		]);
		expect(
			geminiAcpCommands.every((command) => command.name.startsWith("gemini-")),
		).toBe(true);
	});

	it("returns a Pi shell when setting a supported model", async () => {
		await saveGeminiAcpSettings(
			{ enabled: true, command: "gemini", args: ["--acp"] },
			{ rootDir },
		);

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

	it("persists restrictive policy without risk confirmation", async () => {
		const result = await setGeminiPermissionPolicy(
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
		const result = await setGeminiPermissionPolicy(
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
		const result = await setGeminiPermissionPolicy(
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
