import { mkdtemp, rm } from "node:fs/promises";
import os, { homedir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GeminiAcpConfig } from "../../types.ts";
import { resolveAccountsConfig } from "../account-config.ts";
import { executeWithAccountPool, hasAccountPool } from "../account-pool-singleton.ts";
import { AccountPool } from "../account-pool.ts";
import type { GeminiAcpCommandSettings } from "../client.ts";
import { createFileCooldownStore } from "../cooldown-store.ts";
import { buildGeminiAcpCommandSettings } from "../settings.ts";

/** Simulates what loadConfig() does: JSON round-trip produces a fresh object reference. */
function reloadConfig(config: GeminiAcpConfig): GeminiAcpConfig {
	return JSON.parse(JSON.stringify(config)) as GeminiAcpConfig;
}

/**
 * Creates an executeWithAccountPool-equivalent bound to an isolated temp dir, so tests don't share
 * or pollute the real ~/.pi/gemini-acp cooldown store.
 */
function makeIsolatedExecute(tmpDir: string) {
	return async function execute<T>(
		config: GeminiAcpConfig,
		operation: (commandSettings: GeminiAcpCommandSettings) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const resolved = resolveAccountsConfig(config.providers?.accounts);
		if (!resolved) {
			return await operation(buildGeminiAcpCommandSettings(config.providers?.["gemini-acp"]));
		}
		const store = createFileCooldownStore({ rootDir: tmpDir });
		const pool = new AccountPool(resolved, store);
		await pool.loadPersistedCooldowns();
		const settings = config.providers?.["gemini-acp"];
		return await pool.execute(async (accountEnv) => {
			return await operation(buildGeminiAcpCommandSettings(settings, accountEnv));
		}, signal);
	};
}

describe("account pool integration (no accounts / single account)", () => {
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
});

describe("account pool integration (multi-account, isolated store)", () => {
	let tmpDir: string;
	let execute: ReturnType<typeof makeIsolatedExecute>;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-gemini-acp-test-"));
		execute = makeIsolatedExecute(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
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
		const result = await execute(config, async (settings: GeminiAcpCommandSettings) => {
			expect(settings.env).toBeDefined();
			expect(settings.env?.GEMINI_CLI_HOME).toBe("/test/home");
			expect(settings.command).toBe("gemini");
			expect(settings.args).toContain("--acp");
			return "with-env";
		});
		expect(result).toBe("with-env");
	});

	it("fails over to second account on error within a single call", async () => {
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini" },
				accounts: {
					failover: { retries: 0, codes: [429], coolDownSeconds: 60 },
					entries: [
						{ name: "a", env: { GEMINI_CLI_HOME: "/a" } },
						{ name: "b", env: { GEMINI_CLI_HOME: "/b" } },
					],
				},
			},
		};
		const calls: string[] = [];
		const result = await execute(config, async (settings: GeminiAcpCommandSettings) => {
			const home = settings.env?.GEMINI_CLI_HOME ?? "none";
			calls.push(home);
			if (home === "/a") {
				throw new Error(
					"You have exhausted your capacity on this model. Your quota will reset after 1h.",
				);
			}
			return "from-b";
		});
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
		const result = await execute(config, async (settings: GeminiAcpCommandSettings) => {
			return settings.env?.GEMINI_CLI_HOME ?? "none";
		});
		expect(result).toBe("/active");
	});

	it("expands tilde in account env and uses expanded path for failover", async () => {
		// GEMINI_CLI_HOME: "~/.gemini-secondary" must be expanded to the real homedir path
		// before being passed to the child process, because Node.js does not expand ~ in env.
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini" },
				accounts: {
					failover: { retries: 0, codes: [429], coolDownSeconds: 60 },
					entries: [
						{ name: "primary", env: { GEMINI_CLI_HOME: "" } },
						{ name: "secondary", env: { GEMINI_CLI_HOME: "~/.gemini-secondary" } },
					],
				},
			},
		};
		const seenHomes: string[] = [];
		await execute(config, async (settings) => {
			const home = settings.env?.GEMINI_CLI_HOME ?? "unset";
			seenHomes.push(home);
			if (home === "") {
				throw new Error(
					"You have exhausted your capacity on this model. Your quota will reset after 1h.",
				);
			}
			return "ok";
		});
		expect(seenHomes).toEqual(["", `${homedir()}/.gemini-secondary`]);
	});

	it("persists cooldown to disk so subsequent module re-loads skip exhausted account", async () => {
		// This reproduces the real bug: jiti reloads the module (moduleCache: false) on every
		// tool invocation, so in-memory singletons don't survive. Cooldowns must be persisted
		// to disk and reloaded at the start of each executeWithAccountPool call.
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini" },
				accounts: {
					failover: { retries: 0, codes: [429], coolDownSeconds: 3600 },
					entries: [
						{ name: "primary", env: { GEMINI_CLI_HOME: "/primary" } },
						{ name: "secondary", env: { GEMINI_CLI_HOME: "/secondary" } },
					],
				},
			},
		};

		// First call: primary fails, cooldown written to disk, secondary succeeds.
		const callsFirst: string[] = [];
		await execute(reloadConfig(config), async (settings) => {
			const home = settings.env?.GEMINI_CLI_HOME ?? "none";
			callsFirst.push(home);
			if (home === "/primary") {
				throw new Error(
					"You have exhausted your capacity on this model. Your quota will reset after 1h.",
				);
			}
			return "ok";
		});
		expect(callsFirst).toEqual(["/primary", "/secondary"]);

		// Second call: simulates a fresh module load (new AccountPool instance, no in-memory state).
		// Cooldown is loaded from disk — primary must still be skipped.
		const callsSecond: string[] = [];
		const result = await execute(reloadConfig(config), async (settings) => {
			const home = settings.env?.GEMINI_CLI_HOME ?? "none";
			callsSecond.push(home);
			return `from-${home}`;
		});
		expect(callsSecond).toEqual(["/secondary"]);
		expect(result).toBe("from-/secondary");
	});

	it("does not skip account after cooldown expires", async () => {
		const config: GeminiAcpConfig = {
			providers: {
				"gemini-acp": { enabled: true, command: "gemini" },
				accounts: {
					failover: { retries: 0, codes: [429], coolDownSeconds: 0 },
					entries: [{ name: "primary", env: { GEMINI_CLI_HOME: "/primary" } }],
				},
			},
		};

		// Record an already-expired cooldown directly via the store.
		const store = createFileCooldownStore({ rootDir: tmpDir });
		await store.save(
			new Map([
				["primary", { accountName: "primary", coolUntil: Date.now() - 1000, reason: "expired" }],
			]),
		);

		// Primary should be healthy again.
		const calls: string[] = [];
		await execute(config, async (settings) => {
			calls.push(settings.env?.GEMINI_CLI_HOME ?? "none");
			return "ok";
		});
		expect(calls).toEqual(["/primary"]);
	});
});
