import { describe, expect, it } from "vitest";

import { buildGeminiAcpCommandSettings } from "../settings.ts";

describe("buildGeminiAcpCommandSettings", () => {
	it("appends --skip-trust and the selected model when not already configured", () => {
		expect(
			buildGeminiAcpCommandSettings({
				command: "gemini",
				args: ["--acp"],
				model: "gemini-2.5-pro",
			}),
		).toEqual({
			command: "gemini",
			args: ["--acp", "--skip-trust", "--model", "gemini-2.5-pro"],
		});
	});

	it("does not duplicate --skip-trust or existing model flags", () => {
		expect(
			buildGeminiAcpCommandSettings({
				command: "gemini",
				args: ["--acp", "--skip-trust", "--model=gemini-2.5-flash"],
				model: "gemini-2.5-pro",
			}).args,
		).toEqual(["--acp", "--skip-trust", "--model=gemini-2.5-flash"]);
	});

	it("maps gemini-auto to --model auto for Gemini CLI", () => {
		expect(
			buildGeminiAcpCommandSettings({
				command: "gemini",
				args: ["--acp"],
				model: "gemini-auto",
			}),
		).toEqual({
			command: "gemini",
			args: ["--acp", "--skip-trust", "--model", "auto"],
		});
	});
});
