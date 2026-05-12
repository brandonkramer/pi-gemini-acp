/** @file Test helpers for environment manipulation. */

/** Temporarily sets an env var, runs fn, then restores the original value. */
export function withEnv<T>(key: string, value: string, fn: () => T): T {
	const prev = process.env[key];
	process.env[key] = value;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
}
