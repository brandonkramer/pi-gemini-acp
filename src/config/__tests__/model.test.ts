import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelStatus, setGeminiAcpModel } from "../model.js";
import { loadConfig, saveGeminiAcpSettings } from "../settings.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-model-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("Gemini ACP model configuration", () => {
	it("persists a model after confirming --model support", async () => {
		await saveGeminiAcpSettings(
			{ enabled: true, command: "gemini", args: ["--acp"] },
			{ rootDir },
		);

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
		expect(config.providers?.["gemini-acp"]?.modelSelectionAvailable).toBe(
			true,
		);
		expect(config.providers?.["gemini-acp"]?.modelSelectionCheckedAt).toBe(
			"2026-05-02T00:00:00.000Z",
		);
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
		await saveGeminiAcpSettings(
			{ enabled: true, command: "gemini", args: ["--acp"] },
			{ rootDir },
		);

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
