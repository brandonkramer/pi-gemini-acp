import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config/settings.js";
import type { ResultEnvelope } from "../../types.js";
import type { PiCommandContext } from "../define.js";
import { runGeminiConfigCommand } from "../gemini-config.js";
import { runGeminiModelCommand } from "../gemini-model.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-picker-ui-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

function makeInteractiveCtx(options: {
	select?: Array<string | undefined>;
	input?: Array<string | undefined> | string | undefined;
	confirm?: boolean;
}): {
	ctx: PiCommandContext;
	select: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
} {
	const selections = [...(options.select ?? [])];
	const inputs = Array.isArray(options.input) ? [...options.input] : [options.input];
	const select = vi.fn(async () => selections.shift());
	const confirm = vi.fn(async () => options.confirm ?? false);
	const input = vi.fn(async () => inputs.shift());
	const notify = vi.fn();
	return {
		ctx: {
			hasUI: true,
			ui: { select, confirm, input, notify },
		},
		select,
		confirm,
		input,
		notify,
	};
}

describe("Gemini ACP command pickers", () => {
	it("uses Pi select for /gemini-config with no args", async () => {
		const { ctx, select } = makeInteractiveCtx({ select: [undefined] });

		const result = await runGeminiConfigCommand({}, ctx, { rootDir });

		expect(select).toHaveBeenCalledWith(
			"Gemini config",
			["Status", "ACP command", "Permissions", "Trust current folder", "Cache", "Recall"],
			{ signal: undefined },
		);
		expect(result.content[0]?.text).toBe("Cancelled.");
	});

	it("stages command edits before saving ACP command settings", async () => {
		const { ctx, select, input } = makeInteractiveCtx({
			select: ["ACP command", "Command: gemini", "Save and apply"],
			input: "gemini-dev",
		});

		const result = await runGeminiConfigCommand({}, ctx, {
			rootDir,
			commandExists: async (command) => command === "gemini-dev",
		});

		expect(input).toHaveBeenCalledWith("Edit command", "gemini", {
			signal: undefined,
		});
		expect(select).toHaveBeenNthCalledWith(
			3,
			"ACP command settings",
			expect.arrayContaining(["Command: gemini-dev"]),
			{ signal: undefined },
		);
		expect(result.content[0]?.text).toContain("Saved Gemini ACP command: gemini-dev --acp");
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toMatchObject({
			command: "gemini-dev",
			args: ["--acp"],
		});
	});

	it("stages added args before saving ACP command settings", async () => {
		const { ctx, select, input } = makeInteractiveCtx({
			select: ["ACP command", "Args: --acp", "Add new arg", "Done", "Save and apply"],
			input: "--verbose",
		});

		await runGeminiConfigCommand({}, ctx, {
			rootDir,
			commandExists: async () => true,
		});

		expect(input).toHaveBeenCalledWith("New argument", "", {
			signal: undefined,
		});
		expect(select).toHaveBeenCalledWith(
			"Edit Gemini ACP args",
			expect.arrayContaining(["Remove --verbose"]),
			{ signal: undefined },
		);
		expect(select).toHaveBeenCalledWith(
			"ACP command settings",
			expect.arrayContaining(["Args: --acp --verbose"]),
			{ signal: undefined },
		);
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toMatchObject({
			args: ["--acp", "--verbose"],
		});
	});

	it("stages removed args before saving ACP command settings", async () => {
		await runGeminiConfigCommand(
			{
				action: "command",
				executable: "gemini",
				args: ["--acp", "--model", "gemini-3.1-pro"],
			},
			undefined,
			{ rootDir, commandExists: async () => true },
		);
		const { ctx, select } = makeInteractiveCtx({
			select: [
				"ACP command",
				"Args: --acp --model gemini-3.1-pro",
				"Remove --model",
				"Done",
				"Save and apply",
			],
		});

		await runGeminiConfigCommand({}, ctx, {
			rootDir,
			commandExists: async () => true,
		});

		expect(select).toHaveBeenCalledWith(
			"Edit Gemini ACP args",
			expect.not.arrayContaining(["Remove --model"]),
			{ signal: undefined },
		);
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toMatchObject({
			args: ["--acp", "gemini-3.1-pro"],
		});
	});

	it("opens ACP command settings directly for /gemini-config command with no executable", async () => {
		const { ctx, select } = makeInteractiveCtx({
			select: ["Save and apply"],
		});

		await runGeminiConfigCommand({ action: "command" }, ctx, {
			rootDir,
			commandExists: async () => true,
		});

		expect(select).toHaveBeenCalledWith(
			"ACP command settings",
			["Command: gemini", "Args: --acp", "Save and apply", "Cancel"],
			{ signal: undefined },
		);
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toMatchObject({
			command: "gemini",
			args: ["--acp"],
		});
	});

	it("cancels ACP command settings without saving", async () => {
		const { ctx } = makeInteractiveCtx({ select: [undefined] });

		const result = await runGeminiConfigCommand({ action: "command" }, ctx, {
			rootDir,
		});

		expect(result.content[0]?.text).toBe("Cancelled.");
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toBeUndefined();
	});

	it("persists default settings for headless /gemini-config command", async () => {
		const result = await runGeminiConfigCommand({ action: "command" }, undefined, {
			rootDir,
			commandExists: async () => true,
		});

		expect(result.content[0]?.text).toContain("Saved Gemini ACP command: gemini --acp");
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toMatchObject({
			command: "gemini",
			args: ["--acp"],
		});
	});

	it("uses Pi select for /gemini-model with no args", async () => {
		const { ctx, select } = makeInteractiveCtx({
			select: ["Gemini 3.1 Pro Preview — gemini-3.1-pro-preview"],
		});

		const result = await runGeminiModelCommand({}, ctx, {
			rootDir,
			commandExists: async () => true,
			readCommandHelp: async () => "--model Model [string]",
		});

		expect(select).toHaveBeenCalledWith(
			"Choose a Gemini model",
			expect.arrayContaining(["Gemini 3.1 Pro Preview — gemini-3.1-pro-preview"]),
			{ signal: undefined },
		);
		expect(result.content[0]?.text).toBe("Selected model: gemini-3.1-pro-preview.");
	});

	it("uses Pi confirm before trusting the current folder for Gemini ACP", async () => {
		const { ctx, confirm } = makeInteractiveCtx({
			select: ["Trust current folder"],
			confirm: true,
		});

		const result = await runGeminiConfigCommand({}, ctx, {
			rootDir,
			commandExists: async () => true,
		});

		expect(confirm).toHaveBeenCalledWith(
			"Trust this folder for Gemini ACP?",
			expect.stringContaining("Gemini ACP starts a local Gemini CLI session"),
			{ signal: undefined },
		);
		expect(result.content[0]?.text).toContain("--skip-trust");
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toMatchObject({
			args: ["--acp", "--skip-trust"],
		});
	});

	it("stops trust configuration when the user declines", async () => {
		const { ctx, confirm } = makeInteractiveCtx({
			select: ["Trust current folder"],
			confirm: false,
		});

		const result = await runGeminiConfigCommand({}, ctx, { rootDir });

		expect(confirm).toHaveBeenCalled();
		expect(result.content[0]?.text).toContain("Cancelled");
		expect((await loadConfig({ rootDir })).providers?.["gemini-acp"]).toBeUndefined();
	});

	it("uses Pi confirm before enabling write permissions", async () => {
		const { ctx, confirm } = makeInteractiveCtx({
			select: ["[ ] Filesystem write (⚠️ requires confirmation)", "Done"],
			confirm: true,
		});

		await runGeminiConfigCommand({ action: "permissions" }, ctx, { rootDir });

		expect(confirm).toHaveBeenCalledWith(
			"Enable Filesystem write?",
			expect.stringContaining("Allow Gemini ACP to write text files to your workspace."),
			{ signal: undefined },
		);
		expect(
			(await loadConfig({ rootDir })).providers?.["gemini-acp"]?.permissionPolicy,
		).toMatchObject({ filesystemWrite: true });
	});

	it("returns a cancelled result when the config picker is dismissed", async () => {
		const { ctx } = makeInteractiveCtx({ select: [] });

		const result = await runGeminiConfigCommand({}, ctx, { rootDir });

		expect(result.content[0]?.text).toBe("Cancelled.");
		expect((result.details as ResultEnvelope).data).toMatchObject({
			cancelled: true,
		});
	});
});
