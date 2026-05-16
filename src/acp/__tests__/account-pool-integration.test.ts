import { afterEach, describe, expect, it } from "vitest";

import type { GeminiAcpConfig } from "../../types.ts";
import {
	clearAccountPool,
	executeWithAccountPool,
	hasAccountPool,
} from "../account-pool-singleton.ts";
import type { GeminiAcpCommandSettings } from "../client.ts";

afterEach(() => {
	clearAccountPool();
});

describe("account pool integration", () => {
	it("returns false for hasAccountPool when no accounts configured", () => {
		const config: GeminiAcpConfig = {
			providers: { "gemini-acp": { enabled: true, command: "gemini" } },
		};
		expect(hasAccountPool(config)).toBe(false);
	});

	it("returns true for hasAccountPool when accounts configured", () => {
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini" },
				accounts: {
					entries: [{ name: "a", env: { GEMINI_CLI_HOME: "/a" } }],
				},
			},
		};
		expect(hasAccountPool(config)).toBe(true);
	});

	it("falls through to direct execution when no accounts", async () => {
		const config: GeminiAcpConfig = {
			providers: { "gemini-acp": { enabled: true, command: "gemini" } },
		};
		const result = await executeWithAccountPool(
			config,
			config.providers?.["gemini-acp"],
			async (settings: GeminiAcpCommandSettings) => {
				expect(settings.env).toBeUndefined();
				return "direct";
			},
		);
		expect(result).toBe("direct");
	});

	it("injects account env into command settings", async () => {
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini", args: ["--acp"] },
				accounts: {
					entries: [{ name: "test-account", env: { GEMINI_CLI_HOME: "/test/home" } }],
				},
			},
		};
		const result = await executeWithAccountPool(
			config,
			config.providers?.["gemini-acp"],
			async (settings: GeminiAcpCommandSettings) => {
				expect(settings.env).toBeDefined();
				expect(settings.env?.GEMINI_CLI_HOME).toBe("/test/home");
				expect(settings.command).toBe("gemini");
				expect(settings.args).toContain("--acp");
				return "with-env";
			},
		);
		expect(result).toBe("with-env");
	});

	it("fails over to second account on error", async () => {
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini" },
				accounts: {
					failover: { retries: 1, codes: [429], coolDownSeconds: 60 },
					entries: [
						{ name: "a", env: { GEMINI_CLI_HOME: "/a" } },
						{ name: "b", env: { GEMINI_CLI_HOME: "/b" } },
					],
				},
			},
		};
		const calls: string[] = [];
		const result = await executeWithAccountPool(
			config,
			config.providers?.["gemini-acp"],
			async (settings: GeminiAcpCommandSettings) => {
				const home = settings.env?.GEMINI_CLI_HOME ?? "none";
				calls.push(home);
				if (home === "/a") {
					throw new Error(
						"You have exhausted your capacity on this model. Your quota will reset after 1h.",
					);
				}
				return "from-b";
			},
		);
		expect(result).toBe("from-b");
		expect(calls).toEqual(["/a", "/b"]);
	});

	it("skips disabled accounts", async () => {
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini" },
				accounts: {
					entries: [
						{ name: "disabled", enabled: false, env: { GEMINI_CLI_HOME: "/disabled" } },
						{ name: "active", env: { GEMINI_CLI_HOME: "/active" } },
					],
				},
			},
		};
		const result = await executeWithAccountPool(
			config,
			config.providers?.["gemini-acp"],
			async (settings: GeminiAcpCommandSettings) => {
				return settings.env?.GEMINI_CLI_HOME ?? "none";
			},
		);
		expect(result).toBe("/active");
	});
});
