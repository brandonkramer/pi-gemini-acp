import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AccountsConfig } from "../../types.ts";
import {
	DEFAULT_FAILOVER_CONFIG,
	expandEnvValue,
	primaryAccountEnv,
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

	it("expands tilde in env values", () => {
		const entries = resolveEnabledAccounts([
			{ name: "a", env: { GEMINI_CLI_HOME: "~/.gemini-secondary" } },
		]);
		expect(entries[0].env.GEMINI_CLI_HOME).toBe(`${homedir()}/.gemini-secondary`);
	});

	it("leaves absolute paths unchanged", () => {
		const entries = resolveEnabledAccounts([
			{ name: "a", env: { GEMINI_CLI_HOME: "/absolute/path" } },
		]);
		expect(entries[0].env.GEMINI_CLI_HOME).toBe("/absolute/path");
	});

	it("leaves empty string unchanged", () => {
		const entries = resolveEnabledAccounts([{ name: "a", env: { GEMINI_CLI_HOME: "" } }]);
		expect(entries[0].env.GEMINI_CLI_HOME).toBe("");
	});

	it("expands $VAR unix env references", () => {
		const entries = resolveEnabledAccounts([
			{ name: "a", env: { GEMINI_CLI_HOME: "$HOME/.gemini-secondary" } },
		]);
		const expected = expandEnvValue("$HOME/.gemini-secondary", process.env);
		expect(entries[0].env.GEMINI_CLI_HOME).toBe(expected);
	});
});

describe("expandEnvValue", () => {
	const env = { HOME: "/home/user", USERPROFILE: "C:\\Users\\user", MY_VAR: "hello" };

	it("expands ~/", () => {
		expect(expandEnvValue("~/.gemini", env)).toBe(path.join(homedir(), ".gemini"));
	});

	it("expands $VAR", () => {
		expect(expandEnvValue("$HOME/.gemini", env)).toBe("/home/user/.gemini");
	});

	it("expands ${VAR} is not supported - leaves as-is", () => {
		expect(expandEnvValue("${HOME}/.gemini", env)).toBe("${HOME}/.gemini");
	});

	it("expands %VAR% (Windows-style)", () => {
		expect(expandEnvValue("%USERPROFILE%\\.gemini", env)).toBe("C:\\Users\\user\\.gemini");
	});

	it("leaves unknown $VAR unexpanded", () => {
		expect(expandEnvValue("$UNKNOWN_VAR/path", env)).toBe("$UNKNOWN_VAR/path");
	});

	it("leaves unknown %VAR% unexpanded", () => {
		expect(expandEnvValue("%UNKNOWN_VAR%\\path", env)).toBe("%UNKNOWN_VAR%\\path");
	});

	it("leaves plain absolute path unchanged", () => {
		expect(expandEnvValue("/absolute/path", env)).toBe("/absolute/path");
	});

	it("leaves empty string unchanged", () => {
		expect(expandEnvValue("", env)).toBe("");
	});

	it("expands multiple $VAR references in one value", () => {
		expect(expandEnvValue("$HOME/$MY_VAR", env)).toBe("/home/user/hello");
	});
});

describe("primaryAccountEnv", () => {
	it("returns the first enabled account env for non-pool startup paths", () => {
		const config: AccountsConfig = {
			entries: [
				{ name: "disabled", enabled: false, env: { GEMINI_CLI_HOME: "/disabled" } },
				{ name: "primary", env: { GEMINI_CLI_HOME: "/primary" } },
				{ name: "secondary", env: { GEMINI_CLI_HOME: "/secondary" } },
			],
		};

		expect(primaryAccountEnv(config)).toEqual({ GEMINI_CLI_HOME: "/primary" });
	});

	it("returns undefined when there is no enabled account", () => {
		expect(
			primaryAccountEnv({
				entries: [{ name: "disabled", enabled: false, env: { GEMINI_CLI_HOME: "/disabled" } }],
			}),
		).toBeUndefined();
	});
});
