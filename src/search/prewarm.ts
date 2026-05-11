/** @file Best-effort Gemini ACP search prewarm and runtime status. */
import {
	warmCachedGeminiAcpSearchClient,
	type GeminiAcpClientWarmOptions,
} from "../acp/client-cache.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import { configFromEnv, loadConfig, withDefaultGeminiAcpConfig } from "../config/settings.js";
import type { GeminiAcpAuthProbe, StatusCommandChecker } from "../config/status.js";
import type { GeminiAcpConfig, StructuredError } from "../types.js";
import { primeSuccessfulGeminiSearchPreflight } from "./run.js";

const PREWARM_DISABLED_ENV = "PI_GEMINI_ACP_NO_PREWARM";

/** Options controlling best-effort Gemini ACP search prewarm. */
export interface GeminiSearchPrewarmOptions {
	rootDir?: string;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

/** Test seams for search prewarm without spawning a real Gemini ACP subprocess. */
export interface GeminiSearchPrewarmDeps {
	commandExists?: StatusCommandChecker;
	authProbe?: GeminiAcpAuthProbe;
	loadConfig?: (options: { rootDir?: string }) => Promise<GeminiAcpConfig>;
	warmSearchClient?: (
		settings: Parameters<typeof warmCachedGeminiAcpSearchClient>[0],
		options?: GeminiAcpClientWarmOptions,
	) => Promise<void>;
	schedule?: (callback: () => void) => PrewarmScheduleHandle | void;
}

/** Outcome of a best-effort prewarm attempt; failures are reported, not thrown. */
export interface GeminiSearchPrewarmResult {
	attempted: boolean;
	warmed: boolean;
	skippedReason?: "disabled" | "aborted" | "preflight" | "failed";
	error?: StructuredError;
	cause?: unknown;
}

/** Process-local visibility into the latest Gemini search prewarm attempt. */
export interface GeminiSearchPrewarmStatus {
	state: "not_started" | "running" | "warmed" | "disabled" | "skipped" | "failed";
	attempted: boolean;
	warmed: boolean;
	startedAt?: string;
	finishedAt?: string;
	skippedReason?: GeminiSearchPrewarmResult["skippedReason"];
	error?: StructuredError;
}

let latestPrewarmStatus: GeminiSearchPrewarmStatus = {
	state: "not_started",
	attempted: false,
	warmed: false,
};

/** Returns the latest process-local Gemini search prewarm status. */
export function getGeminiSearchPrewarmStatus(): GeminiSearchPrewarmStatus {
	return { ...latestPrewarmStatus };
}

/** Resets process-local prewarm status for deterministic tests. */
export function __resetGeminiSearchPrewarmStatus(): void {
	latestPrewarmStatus = {
		state: "not_started",
		attempted: false,
		warmed: false,
	};
}

/** Timer-like handle returned by the activation prewarm scheduler. */
export interface PrewarmScheduleHandle {
	unref?: () => void;
}

/** Schedules search prewarm after extension activation has returned. */
export function scheduleGeminiSearchPrewarm(
	options: GeminiSearchPrewarmOptions = {},
	deps: GeminiSearchPrewarmDeps = {},
): void {
	if (prewarmDisabled(options.env ?? process.env)) return;
	const callback = () => {
		void prewarmGeminiSearchClient(options, deps);
	};
	const handle = (deps.schedule ?? defaultSchedule)(callback);
	handle?.unref?.();
}

/**
 * Warms the cached Gemini ACP search process and search preflight cache.
 *
 * This is intentionally best-effort because Gemini ACP is optional and activation must remain
 * reliable when the local command/auth/grounding is absent.
 */
export async function prewarmGeminiSearchClient(
	options: GeminiSearchPrewarmOptions = {},
	deps: GeminiSearchPrewarmDeps = {},
): Promise<GeminiSearchPrewarmResult> {
	if (prewarmDisabled(options.env ?? process.env)) {
		return finishPrewarm(undefined, {
			attempted: false,
			warmed: false,
			skippedReason: "disabled",
		});
	}
	if (options.signal?.aborted) {
		return finishPrewarm(undefined, {
			attempted: false,
			warmed: false,
			skippedReason: "aborted",
		});
	}
	const startedAt = new Date().toISOString();
	latestPrewarmStatus = {
		state: "running",
		attempted: true,
		warmed: false,
		startedAt,
	};
	try {
		const loaded = await (deps.loadConfig ?? loadConfig)({
			rootDir: options.rootDir,
		});
		const config = withDefaultGeminiAcpConfig(configFromEnv(loaded));
		const settings = config.providers?.["gemini-acp"];
		const commandSettings = buildGeminiAcpCommandSettings(settings);
		const preflight = await primeSuccessfulGeminiSearchPreflight(settings, commandSettings, {
			commandExists: deps.commandExists,
			requireSearchGrounding: true,
			rootDir: options.rootDir,
			signal: options.signal,
			authProbe: deps.authProbe,
			persistAuthConfirmation: true,
		});
		if (preflight) {
			return finishPrewarm(startedAt, {
				attempted: true,
				warmed: false,
				skippedReason: "preflight",
				error: preflight,
			});
		}
		await (deps.warmSearchClient ?? warmCachedGeminiAcpSearchClient)(commandSettings, {
			signal: options.signal,
		});
		return finishPrewarm(startedAt, { attempted: true, warmed: true });
	} catch (cause) {
		return finishPrewarm(startedAt, {
			attempted: true,
			warmed: false,
			skippedReason: "failed",
			cause,
		});
	}
}

function finishPrewarm(
	startedAt: string | undefined,
	result: GeminiSearchPrewarmResult,
): GeminiSearchPrewarmResult {
	latestPrewarmStatus = {
		state: prewarmStatusState(result),
		attempted: result.attempted,
		warmed: result.warmed,
		startedAt,
		finishedAt: new Date().toISOString(),
		skippedReason: result.skippedReason,
		error: result.error,
	};
	return result;
}

function prewarmStatusState(result: GeminiSearchPrewarmResult): GeminiSearchPrewarmStatus["state"] {
	if (result.warmed) return "warmed";
	if (result.skippedReason === "disabled") return "disabled";
	if (result.skippedReason === "failed") return "failed";
	return "skipped";
}

function prewarmDisabled(env: NodeJS.ProcessEnv): boolean {
	return /^(?:1|true|yes)$/iu.test(env[PREWARM_DISABLED_ENV] ?? "");
}

function defaultSchedule(callback: () => void): PrewarmScheduleHandle {
	return typeof setImmediate === "function" ? setImmediate(callback) : setTimeout(callback, 0);
}
