/** @file Host git identity resolution for sandboxed ACP sessions. */
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Env vars that carry git's author/committer identity.
 *
 * Gemini CLI sandboxes the shell tools it runs by wiping git configuration: its `getSafeGitEnv`
 * helper deletes every `GIT_CONFIG_*` env var and forces `GIT_CONFIG_GLOBAL=/dev/null` +
 * `GIT_CONFIG_NOSYSTEM=1` before spawning a command. As a result, `git commit` inside an ACP shell
 * fails with "Author identity unknown" even on a fully configured host.
 *
 * The author/committer `*_NAME` / `*_EMAIL` env vars, however, are _not_ stripped (they do not
 * start with `GIT_CONFIG_`), and git honors them as identity overrides. Exposing the user's real
 * identity through them is the only lever that lets in-sandbox git commands commit as the user.
 */
export type GitIdentityEnv = Partial<
	Record<
		"GIT_AUTHOR_NAME" | "GIT_AUTHOR_EMAIL" | "GIT_COMMITTER_NAME" | "GIT_COMMITTER_EMAIL",
		string
	>
>;

/** `git config` lookups per directory and key; environment overrides are applied per call. */
const cache = new Map<string, string | undefined>();

/**
 * Reads a single identity value as git would resolve it in `cwd`: system, global, `includeIf`
 * sections and repository-local config all apply, so a per-repository identity (e.g. work vs.
 * personal) is honored.
 */
function readIdentityValue(key: "user.name" | "user.email", cwd: string): string | undefined {
	try {
		const out = execFileSync("git", ["config", "--get", key], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Returns the git identity effective in `cwd` as `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env overrides.
 * `git config` lookups are memoized per directory; values from `env` always win. Returns an empty
 * object when the identity cannot be determined (the caller then injects nothing).
 *
 * The identity is injected into the Gemini ACP process environment at spawn time, and one process
 * may serve several ACP sessions, so callers should pass the directory Pi works in (by default
 * `process.cwd()`).
 */
export function resolveGitIdentityEnv(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): GitIdentityEnv {
	const dir = path.resolve(cwd);
	const name = env.GIT_AUTHOR_NAME ?? cachedIdentityValue("user.name", dir);
	const email = env.GIT_AUTHOR_EMAIL ?? cachedIdentityValue("user.email", dir);
	const resolved: GitIdentityEnv = {};
	if (name) {
		resolved.GIT_AUTHOR_NAME = name;
		resolved.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME ?? name;
	}
	if (email) {
		resolved.GIT_AUTHOR_EMAIL = email;
		resolved.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL ?? email;
	}
	return resolved;
}

function cachedIdentityValue(key: "user.name" | "user.email", dir: string): string | undefined {
	const cacheKey = `${dir}\0${key}`;
	if (!cache.has(cacheKey)) cache.set(cacheKey, readIdentityValue(key, dir));
	return cache.get(cacheKey);
}

/** Resets the memoized identity cache for tests. */
export function resetGitIdentityCacheForTesting(): void {
	cache.clear();
}
