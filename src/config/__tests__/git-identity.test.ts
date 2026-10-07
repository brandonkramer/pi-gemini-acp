import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientCacheKey } from "../../acp/client-cache-key.ts";
import { withGitIdentityForCwd } from "../../acp/settings.ts";
import { resetGitIdentityCacheForTesting, resolveGitIdentityEnv } from "../git-identity.ts";

describe("resolveGitIdentityEnv", () => {
	beforeEach(() => {
		resetGitIdentityCacheForTesting();
	});

	afterEach(() => {
		resetGitIdentityCacheForTesting();
	});

	it("prefers explicit GIT_AUTHOR_* and GIT_COMMITTER_* environment variables", () => {
		const env = {
			GIT_AUTHOR_NAME: "Alice Test",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Bob Committer",
			GIT_COMMITTER_EMAIL: "bob@example.com",
		};
		const result = resolveGitIdentityEnv(env);
		expect(result).toEqual({
			GIT_AUTHOR_NAME: "Alice Test",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Bob Committer",
			GIT_COMMITTER_EMAIL: "bob@example.com",
		});
	});

	it("defaults committer identity to author identity when committer vars are absent", () => {
		const env = {
			GIT_AUTHOR_NAME: "Alice Test",
			GIT_AUTHOR_EMAIL: "alice@example.com",
		};
		const result = resolveGitIdentityEnv(env);
		expect(result).toEqual({
			GIT_AUTHOR_NAME: "Alice Test",
			GIT_AUTHOR_EMAIL: "alice@example.com",
			GIT_COMMITTER_NAME: "Alice Test",
			GIT_COMMITTER_EMAIL: "alice@example.com",
		});
	});

	it("applies environment overrides on every call instead of caching them", () => {
		const first = resolveGitIdentityEnv({
			GIT_AUTHOR_NAME: "First Call",
			GIT_AUTHOR_EMAIL: "first@example.com",
		});
		expect(first.GIT_AUTHOR_NAME).toBe("First Call");
		const second = resolveGitIdentityEnv({
			GIT_AUTHOR_NAME: "Second Call",
			GIT_AUTHOR_EMAIL: "second@example.com",
		});
		expect(second.GIT_AUTHOR_NAME).toBe("Second Call");
		expect(second.GIT_COMMITTER_EMAIL).toBe("second@example.com");
	});

	it("resolves identity without throwing when env vars are absent", () => {
		const result = resolveGitIdentityEnv({});
		expect(typeof result).toBe("object");
	});

	describe("with a controlled git configuration", () => {
		const saved: Record<string, string | undefined> = {};
		const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME"] as const;
		let root = "";

		beforeEach(() => {
			root = realpathSync(mkdtempSync(path.join(tmpdir(), "git-identity-")));
			for (const key of keys) saved[key] = process.env[key];
			const workConfig = path.join(root, "work.gitconfig");
			writeFileSync(workConfig, "[user]\n\tname = Work Name\n\temail = work@example.com\n");
			const globalConfig = path.join(root, "global.gitconfig");
			writeFileSync(
				globalConfig,
				[
					"[user]",
					"\tname = Personal Name",
					"\temail = personal@example.com",
					`[includeIf "gitdir:${root}/work/"]`,
					`\tpath = ${workConfig}`,
					"",
				].join("\n"),
			);
			process.env.GIT_CONFIG_GLOBAL = globalConfig;
			process.env.GIT_CONFIG_NOSYSTEM = "1";
			process.env.HOME = root;
			for (const dir of ["work", "personal"]) {
				mkdirSync(path.join(root, dir));
				execFileSync("git", ["init", "-q"], { cwd: path.join(root, dir) });
			}
		});

		afterEach(() => {
			for (const key of keys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
			rmSync(root, { recursive: true, force: true });
		});

		it("honors includeIf identities of the given working directory", () => {
			expect(resolveGitIdentityEnv({}, path.join(root, "work"))).toEqual({
				GIT_AUTHOR_NAME: "Work Name",
				GIT_AUTHOR_EMAIL: "work@example.com",
				GIT_COMMITTER_NAME: "Work Name",
				GIT_COMMITTER_EMAIL: "work@example.com",
			});
		});

		it("caches per directory, not per process", () => {
			expect(resolveGitIdentityEnv({}, path.join(root, "work")).GIT_AUTHOR_EMAIL).toBe(
				"work@example.com",
			);
			expect(resolveGitIdentityEnv({}, path.join(root, "personal")).GIT_AUTHOR_EMAIL).toBe(
				"personal@example.com",
			);
		});

		it("caches git config lookups but lets the environment override them", () => {
			const repo = path.join(root, "personal");
			expect(resolveGitIdentityEnv({}, repo).GIT_AUTHOR_EMAIL).toBe("personal@example.com");
			execFileSync("git", ["config", "user.email", "changed@example.com"], { cwd: repo });
			expect(resolveGitIdentityEnv({}, repo).GIT_AUTHOR_EMAIL).toBe("personal@example.com");
			expect(
				resolveGitIdentityEnv({ GIT_AUTHOR_EMAIL: "env@example.com" }, repo).GIT_AUTHOR_EMAIL,
			).toBe("env@example.com");
		});

		it("gives chat processes in repositories with different identities different cache keys", () => {
			for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"]) vi.stubEnv(key, undefined);
			try {
				const base = { command: "gemini", args: ["--acp"], env: { GEMINI_CLI_HOME: "/acct" } };
				const work = withGitIdentityForCwd(base, path.join(root, "work"));
				const personal = withGitIdentityForCwd(base, path.join(root, "personal"));
				expect(work.env).toMatchObject({
					GIT_AUTHOR_EMAIL: "work@example.com",
					GEMINI_CLI_HOME: "/acct",
				});
				expect(personal.env?.GIT_AUTHOR_EMAIL).toBe("personal@example.com");
				expect(clientCacheKey(work)).not.toBe(clientCacheKey(personal));
				// Account environment variables win over the resolved identity.
				const overridden = withGitIdentityForCwd(
					{ ...base, env: { GIT_AUTHOR_EMAIL: "account@example.com" } },
					path.join(root, "work"),
				);
				expect(overridden.env?.GIT_AUTHOR_EMAIL).toBe("account@example.com");
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("honors repository-local identity", () => {
			const repo = path.join(root, "personal");
			execFileSync("git", ["config", "user.email", "local@example.com"], { cwd: repo });
			expect(resolveGitIdentityEnv({}, repo).GIT_AUTHOR_EMAIL).toBe("local@example.com");
		});
	});
});
