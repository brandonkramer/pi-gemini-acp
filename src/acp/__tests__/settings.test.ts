import { describe, expect, it } from "vitest";
import { buildGeminiAcpCommandSettings } from "../settings.js";

describe("buildGeminiAcpCommandSettings", () => {
	it("appends the selected model when no model flag is already configured", () => {
		expect(
			buildGeminiAcpCommandSettings({
				command: "gemini",
				args: ["--acp"],
				model: "gemini-2.5-pro",
			}),
		).toEqual({
			command: "gemini",
			args: ["--acp", "--model", "gemini-2.5-pro"],
		});
	});

	it("does not duplicate existing model flags", () => {
		expect(
			buildGeminiAcpCommandSettings({
				command: "gemini",
				args: ["--acp", "--model=gemini-2.5-flash"],
				model: "gemini-2.5-pro",
			}).args,
		).toEqual(["--acp", "--model=gemini-2.5-flash"]);
	});
});
