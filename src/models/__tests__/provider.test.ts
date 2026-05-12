import { describe, expect, it, vi } from "vitest";

import { registerGeminiAcpModelProvider } from "../provider.ts";
import { withEnv } from "./env-helpers.ts";

describe("registerGeminiAcpModelProvider", () => {
	it("does not register when pi lacks registerProvider", async () => {
		const pi = {};
		await expect(registerGeminiAcpModelProvider(pi, undefined)).resolves.toBeUndefined();
	});

	it("does not register when buildGeminiAcpProviderConfig returns undefined", async () => {
		const pi = { registerProvider: vi.fn() };
		withEnv("PI_GEMINI_ACP_COMMAND", "__nonexistent_gemini_command__", async () => {
			await registerGeminiAcpModelProvider(pi, undefined);
			expect(pi.registerProvider).not.toHaveBeenCalled();
		});
	});
});
