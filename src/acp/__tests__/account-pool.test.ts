import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedAccountsConfig } from "../account-config.ts";
import { AccountPool, allAccountsCooledDown, type CooldownEntry } from "../account-pool.ts";

function makeConfig(
	names: string[],
	overrides?: Partial<ResolvedAccountsConfig["failover"]>,
): ResolvedAccountsConfig {
	return {
		failover: { retries: 2, codes: [429], coolDownSeconds: 60, ...overrides },
		entries: names.map((name) => ({ name, env: { GEMINI_CLI_HOME: `/home/${name}` } })),
	};
}

describe("AccountPool", () => {
	let pool: AccountPool;

	afterEach(() => {
		pool?.clearCooldowns();
	});

	it("executes operation with first account env", async () => {
		pool = new AccountPool(makeConfig(["a", "b"]));
		const result = await pool.execute(async (accountEnv) => {
			expect(accountEnv.GEMINI_CLI_HOME).toBe("/home/a");
			return "ok";
		});
		expect(result).toBe("ok");
	});

	it("retries same account on configured codes before switching", async () => {
		pool = new AccountPool(makeConfig(["a", "b"], { retries: 2, codes: [429] }));
		let attempt = 0;
		const result = await pool.execute(async (accountEnv) => {
			attempt++;
			if (accountEnv.GEMINI_CLI_HOME === "/home/a") {
				const error = new Error("quota exhausted (429)");
				(error as any).statusCode = 429;
				throw error;
			}
			return "from-b";
		});
		expect(result).toBe("from-b");
		expect(attempt).toBe(4);
	});

	it("immediately switches on non-configured error codes", async () => {
		pool = new AccountPool(makeConfig(["a", "b"], { codes: [429] }));
		const calls: string[] = [];
		const result = await pool.execute(async (accountEnv) => {
			const home = accountEnv.GEMINI_CLI_HOME;
			calls.push(home);
			if (home === "/home/a") {
				const error = new Error("server error (500)");
				(error as any).statusCode = 500;
				throw error;
			}
			return "from-b";
		});
		expect(result).toBe("from-b");
		expect(calls).toEqual(["/home/a", "/home/b"]);
	});

	it("parses cooldown duration from quota error message", async () => {
		pool = new AccountPool(makeConfig(["a", "b"]));
		await pool.execute(async (accountEnv) => {
			if (accountEnv.GEMINI_CLI_HOME === "/home/a") {
				throw new Error(
					"You have exhausted your capacity on this model. Your quota will reset after 2h21m46s.",
				);
			}
			return "from-b";
		});
		const status = pool.getStatus();
		const cooldown = status.cooldowns.find((c) => c.accountName === "a");
		expect(cooldown).toBeDefined();
		expect(cooldown!.coolUntil).toBeGreaterThan(Date.now());
	});

	it("uses fallback cooldown when no duration in error", async () => {
		pool = new AccountPool(makeConfig(["a", "b"], { coolDownSeconds: 30 }));
		const now = Date.now();
		await pool.execute(async (accountEnv) => {
			if (accountEnv.GEMINI_CLI_HOME === "/home/a") {
				const error = new Error("rate limited");
				(error as any).statusCode = 429;
				throw error;
			}
			return "from-b";
		});
		const status = pool.getStatus();
		const cooldown = status.cooldowns.find((c) => c.accountName === "a");
		expect(cooldown).toBeDefined();
		expect(cooldown!.coolUntil).toBeGreaterThanOrEqual(now + 29_000);
		expect(cooldown!.coolUntil).toBeLessThanOrEqual(now + 31_000);
	});

	it("throws when all accounts are cooled down", async () => {
		pool = new AccountPool(makeConfig(["a"]));
		await expect(
			pool.execute(async () => {
				throw new Error(
					"You have exhausted your capacity on this model. Your quota will reset after 1h.",
				);
			}),
		).rejects.toThrow(/all.*account.*exhausted/iu);
	});

	it("attaches the last underlying error as cause when all accounts fail", async () => {
		pool = new AccountPool(makeConfig(["a", "b"], { retries: 0 }));
		const underlying = new Error(
			"You have exhausted your capacity on this model. Your quota will reset after 1h.",
		);
		const rejection = await pool
			.execute(async () => {
				throw underlying;
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(rejection).toBeDefined();
		expect((rejection as { cause?: unknown }).cause).toBe(underlying);
	});

	it("skips cooled-down accounts on subsequent calls", async () => {
		pool = new AccountPool(makeConfig(["a", "b"]));
		let firstCall = true;
		await pool.execute(async (accountEnv) => {
			if (firstCall && accountEnv.GEMINI_CLI_HOME === "/home/a") {
				firstCall = false;
				throw new Error(
					"You have exhausted your capacity on this model. Your quota will reset after 1h.",
				);
			}
			return `from-${accountEnv.GEMINI_CLI_HOME}`;
		});
		const result = await pool.execute(async (accountEnv) => `from-${accountEnv.GEMINI_CLI_HOME}`);
		expect(result).toBe("from-/home/b");
	});

	it("restores account after cooldown expires", async () => {
		pool = new AccountPool(makeConfig(["a", "b"], { coolDownSeconds: 0 }));
		pool.recordCooldown("a", 0);
		const result = await pool.execute(async (accountEnv) => `from-${accountEnv.GEMINI_CLI_HOME}`);
		expect(result).toBe("from-/home/a");
	});
});

describe("allAccountsCooledDown", () => {
	it("returns true when all entries have future cooldowns", () => {
		const cooldowns = new Map<string, CooldownEntry>([
			["a", { accountName: "a", coolUntil: Date.now() + 60_000, reason: "test" }],
		]);
		const entries = [{ name: "a", env: {} }];
		expect(allAccountsCooledDown(entries, cooldowns)).toBe(true);
	});

	it("returns false when at least one entry has no cooldown", () => {
		const cooldowns = new Map<string, CooldownEntry>();
		const entries = [{ name: "a", env: {} }];
		expect(allAccountsCooledDown(entries, cooldowns)).toBe(false);
	});
});
