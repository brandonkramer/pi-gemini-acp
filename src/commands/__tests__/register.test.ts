import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/settings.js";
import type { ResultEnvelope } from "../../types.js";
import type { PiCommandOptions } from "../define.js";
import { getGeminiModelCompletions, setGeminiModel } from "../gemini-model.js";
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
		const registered: Array<{ name: string; options: PiCommandOptions }> = [];
		registerGeminiAcpCommands({
			registerCommand: (name, options) => {
				registered.push({ name, options });
			},
		});

		expect(registered.map((entry) => entry.name)).toEqual([
			"gemini-model",
			"gemini-set-permission-policy",
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
