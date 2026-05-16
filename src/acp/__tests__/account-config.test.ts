import { describe, expect, it } from "vitest";

import type { AccountsConfig } from "../../types.ts";
import {
	DEFAULT_FAILOVER_CONFIG,
	resolveAccountsConfig,
	resolveEnabledAccounts,
} from "../account-config.ts";

describe("resolveAccountsConfig", () => {
	it("returns undefined when accounts is undefined", () => {
		expect(resolveAccountsConfig(undefined)).toBeUndefined();
	});

	it("returns undefined when entries is empty", () => {
		expect(resolveAccountsConfig({ entries: [] })).toBeUndefined();
	});

	it("returns undefined when all entries are disabled", () => {
		const config: AccountsConfig = {
			entries: [{ name: "a", enabled: false, env: { GEMINI_CLI_HOME: "/a" } }],
		};
		expect(resolveAccountsConfig(config)).toBeUndefined();
	});

	it("resolves failover defaults when failover is omitted", () => {
		const config: AccountsConfig = {
			entries: [{ name: "a", env: { GEMINI_CLI_HOME: "/a" } }],
		};
		const resolved = resolveAccountsConfig(config);
		expect(resolved).toBeDefined();
		expect(resolved!.failover).toEqual(DEFAULT_FAILOVER_CONFIG);
	});

	it("merges partial failover with defaults", () => {
		const config: AccountsConfig = {
			failover: { retries: 5 },
			entries: [{ name: "a", env: { GEMINI_CLI_HOME: "/a" } }],
		};
		const resolved = resolveAccountsConfig(config);
		expect(resolved!.failover.retries).toBe(5);
		expect(resolved!.failover.codes).toEqual(DEFAULT_FAILOVER_CONFIG.codes);
		expect(resolved!.failover.coolDownSeconds).toBe(DEFAULT_FAILOVER_CONFIG.coolDownSeconds);
	});

	it("filters out disabled entries", () => {
		const config: AccountsConfig = {
			entries: [
				{ name: "a", enabled: true, env: { GEMINI_CLI_HOME: "/a" } },
				{ name: "b", enabled: false, env: { GEMINI_CLI_HOME: "/b" } },
				{ name: "c", env: { GEMINI_CLI_HOME: "/c" } },
			],
		};
		const resolved = resolveAccountsConfig(config);
		expect(resolved!.entries).toHaveLength(2);
		expect(resolved!.entries.map((e) => e.name)).toEqual(["a", "c"]);
	});
});

describe("resolveEnabledAccounts", () => {
	it("treats missing enabled as true", () => {
		const entries = resolveEnabledAccounts([{ name: "a", env: { GEMINI_CLI_HOME: "/a" } }]);
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("a");
	});
});
