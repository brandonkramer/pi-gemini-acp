import { describe, expect, it } from "vitest";
import { evaluateGeminiAcpStatus } from "../status.js";

describe("Gemini ACP status", () => {
	it("reports missing config without checking the command", async () => {
		let checked = false;
		const status = await evaluateGeminiAcpStatus(undefined, async () => {
			checked = true;
			return true;
		});

		expect(checked).toBe(false);
		expect(status.ready).toBe(false);
		expect(status.state).toBe("missing_config");
		expect(status.error?.code).toBe("GEMINI_ACP_MISSING_CONFIG");
		expect(status.remediation.join("\n")).toContain("Configure");
	});

	it("reports a configured command that is missing", async () => {
		const status = await evaluateGeminiAcpStatus(
			{ enabled: true, command: "/opt/gemini/bin/gemini", args: ["--acp"] },
			async () => false,
		);

		expect(status.ready).toBe(false);
		expect(status.state).toBe("command_not_found");
		expect(status.error?.code).toBe("GEMINI_ACP_COMMAND_NOT_FOUND");
		expect(status.command.command).toBe("gemini");
		expect(status.command.pathRedacted).toBe(true);
		expect(status.command.exists).toBe(false);
	});

	it("reports configured but unauthenticated ACP", async () => {
		const status = await evaluateGeminiAcpStatus(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp", "--token", "secret-value"],
				authenticated: false,
				searchGroundingAvailable: true,
			},
			async () => true,
		);

		expect(status.ready).toBe(false);
		expect(status.state).toBe("unauthenticated");
		expect(status.error?.code).toBe("GEMINI_ACP_UNAUTHENTICATED");
		expect(status.command.args).toEqual(["--acp", "--token", "<redacted>"]);
		expect(status.capabilities.authenticated).toBe(false);
		expect(status.capabilities.imageInput).toMatchObject({
			available: "unknown",
			transport: "unconfirmed",
		});
	});

	it("reports a fully configured status with model and permission policy", async () => {
		const status = await evaluateGeminiAcpStatus(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: true,
				searchGroundingAvailable: true,
				model: "gemini-2.5-pro",
				modelSelectionAvailable: true,
				modelSelectionCheckedAt: "2026-05-02T00:00:00.000Z",
				permissionPolicy: { mode: "file-read", reason: "status test" },
			},
			async () => true,
		);

		expect(status.ready).toBe(true);
		expect(status.state).toBe("ready");
		expect(status.error).toBeUndefined();
		expect(status.command.exists).toBe(true);
		expect(status.capabilities.searchGroundingAvailable).toBe(true);
		expect(status.capabilities.model.selectedModel).toBe("gemini-2.5-pro");
		expect(status.capabilities.fileAnalysisAvailable).toBe("unknown");
		expect(status.capabilities.imageInput).toMatchObject({
			available: "unknown",
			transport: "unconfirmed",
			supportedMimeTypes: [
				"image/png",
				"image/jpeg",
				"image/webp",
				"image/gif",
			],
		});
		expect(status.capabilities.permissionPolicy.mode).toBe("file-read");
		expect(
			status.capabilities.permissionPolicy.clientCapabilities.fs.readTextFile,
		).toBe(true);
	});

	it("reports explicitly confirmed file-analysis capability separately from readiness", async () => {
		const status = await evaluateGeminiAcpStatus(
			{
				enabled: true,
				command: "gemini",
				authenticated: true,
				searchGroundingAvailable: true,
				fileAnalysisAvailable: true,
			},
			async () => true,
		);

		expect(status.ready).toBe(true);
		expect(status.capabilities.fileAnalysisAvailable).toBe(true);
	});
});
