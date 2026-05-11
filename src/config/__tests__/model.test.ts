import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { modelStatus, setGeminiAcpModel } from "../model.ts";
import { loadConfig, saveGeminiAcpSettings } from "../settings.ts";

let rootDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-model-"));
	originalPath = process.env.PATH;
});

afterEach(async () => {
	process.env.PATH = originalPath;
	await rm(rootDir, { recursive: true, force: true });
});

describe("Gemini ACP model configuration", () => {
	it("persists a model against the default Gemini ACP command", async () => {
		const result = await setGeminiAcpModel(
			{ model: "gemini-2.5-pro", rootDir },
			{
				commandExists: async () => true,
				readCommandHelp: async () => "Usage: gemini --acp --model <model>",
				now: () => new Date("2026-05-02T00:00:00.000Z"),
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status.selectedModel).toBe("gemini-2.5-pro");
		const config = await loadConfig({ rootDir });
		expect(config.providers?.["gemini-acp"]?.model).toBe("gemini-2.5-pro");
		expect(config.providers?.["gemini-acp"]?.modelSelectionAvailable).toBe(true);
		expect(config.providers?.["gemini-acp"]?.modelSelectionCheckedAt).toBe(
			"2026-05-02T00:00:00.000Z",
		);
	});

	it.skipIf(process.platform === "win32")(
		"probes model support through a resolved PATH executable",
		async () => {
			const binDir = await mkdtemp(path.join(rootDir, "bin-"));
			const geminiPath = path.join(binDir, "gemini");
			await writeFile(geminiPath, "#!/bin/sh\necho 'Usage: gemini --acp --model <model>'\n");
			await chmod(geminiPath, 0o755);
			process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
			await saveGeminiAcpSettings(
				{ enabled: true, command: "gemini", args: ["--acp"] },
				{ rootDir },
			);

			const result = await setGeminiAcpModel({
				model: "gemini-2.5-flash",
				rootDir,
			});

			expect(result.error).toBeUndefined();
			expect(result.status.selectedModel).toBe("gemini-2.5-flash");
		},
	);

	it("returns actionable command resolution errors for missing commands", async () => {
		await saveGeminiAcpSettings(
			{ enabled: true, command: "missing-gemini", args: ["--acp"] },
			{ rootDir },
		);

		const result = await setGeminiAcpModel({
			model: "gemini-2.5-flash",
			rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_ACP_COMMAND_NOT_FOUND");
		expect(result.error?.message).toContain("missing-gemini");
		expect(result.error?.message).toContain("from this Pi process");
	});

	it("rejects model names outside the conservative Gemini pattern", async () => {
		const result = await setGeminiAcpModel(
			{ model: "claude-4", rootDir },
			{ commandExists: async () => true },
		);

		expect(result.error?.code).toBe("GEMINI_ACP_INVALID_MODEL");
		expect((await loadConfig({ rootDir })).providers).toBeUndefined();
	});

	it("reports unsupported model selection without persisting the requested model", async () => {
		await saveGeminiAcpSettings({ enabled: true, command: "gemini", args: ["--acp"] }, { rootDir });

		const result = await setGeminiAcpModel(
			{ model: "models/gemini-2.5-flash", rootDir },
			{
				commandExists: async () => true,
				readCommandHelp: async () => "Usage: custom-acp --no-model-selection",
			},
		);

		expect(result.error?.code).toBe("GEMINI_ACP_MODEL_SELECTION_UNSUPPORTED");
		const settings = (await loadConfig({ rootDir })).providers?.["gemini-acp"];
		expect(settings?.model).toBeUndefined();
		expect(settings?.modelSelectionAvailable).toBe(false);
	});

	it("formats selected model status for status tool and command output", () => {
		expect(
			modelStatus({
				model: "gemini-2.5-pro",
				modelSelectionAvailable: true,
			}).message,
		).toContain("gemini-2.5-pro");
	});
});
