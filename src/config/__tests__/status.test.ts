import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateGeminiAcpStatus, preflightGeminiAcpProvider } from "../status.ts";

const mocks = vi.hoisted(() => ({
	startSession: vi.fn(),
}));

vi.mock("../../acp/session.ts", () => ({
	AcpProcessSession: {
		start: mocks.startSession,
	},
}));

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("Gemini ACP status", () => {
	it("reports missing config without checking the command when provider settings are disabled", async () => {
		let checked = false;
		const status = await evaluateGeminiAcpStatus({ enabled: false }, async () => {
			checked = true;
			return true;
		});

		expect(checked).toBe(false);
		expect(status.ready).toBe(false);
		expect(status.state).toBe("missing_config");
		expect(status.error?.code).toBe("GEMINI_ACP_MISSING_CONFIG");
		expect(status.command.settingsPersisted).toBe(false);
		expect(status.remediation.join("\n")).toContain("disabled");
	});

	it("reports a configured command that is missing", async () => {
		const status = await evaluateGeminiAcpStatus(
			{ enabled: true, command: "/opt/gemini/bin/gemini", args: ["--acp"] },
			async () => false,
		);

		expect(status.ready).toBe(false);
		expect(status.state).toBe("command_not_found");
		expect(status.error?.code).toBe("GEMINI_ACP_COMMAND_NOT_FOUND");
		expect(status.command.settingsPersisted).toBe(true);
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
		expect(status.command.settingsPersisted).toBe(true);
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
				permissionPolicy: { filesystemRead: true, reason: "status test" },
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
			supportedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
		});
		expect(status.capabilities.permissionPolicy.mode).toBe("file-read");
		expect(status.capabilities.permissionPolicy.clientCapabilities.fs.readTextFile).toBe(true);
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

	it("skips the default auth probe without spawning inside a Gemini CLI subprocess", async () => {
		vi.stubEnv("GEMINI_CLI", "1");
		const error = await preflightGeminiAcpProvider(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: false,
				searchGroundingAvailable: true,
			},
			{ commandExists: async () => true },
		);

		expect(error?.code).toBe("GEMINI_ACP_UNAUTHENTICATED");
		expect(error?.message).toContain("skipped inside a Gemini CLI subprocess");
		expect(mocks.startSession).not.toHaveBeenCalled();
	});
});
