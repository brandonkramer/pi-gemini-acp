/**
 * @fileoverview Gemini ACP search parallelism environment controls.
 */

const SEARCH_PARALLEL_ENV = "PI_GEMINI_ACP_SEARCH_PARALLEL";

/** Returns whether live Gemini ACP searches may run concurrently. */
export function geminiAcpSearchParallelEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return /^(?:1|true|yes)$/iu.test(env[SEARCH_PARALLEL_ENV] ?? "");
}
