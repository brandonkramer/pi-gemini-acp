import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { closeGeminiAcpClientCache } from "./acp/client-cache.ts";
/** @file Pi extension entrypoint for Gemini ACP tools, commands, adapters, and models. */
import { registerModelAdapter, type ModelAdapterRegistrar } from "./adapter/register.ts";
import type { PiCommandRegistrar } from "./commands/define.ts";
import { registerGeminiAcpCommands } from "./commands/register.ts";
import { registerGeminiAcpModelProvider } from "./models/provider.ts";
import type { ModelProviderRegistrar } from "./models/types.ts";
import { detectPiScraper, type PiScraperPresence } from "./research/hydrate.ts";
import { scheduleGeminiSearchPrewarm } from "./search/prewarm.ts";
import { sweepResponseCacheRetention } from "./storage/retention.ts";
import type { PiToolRegistrar } from "./tools/define.ts";
import { registerGeminiAcpTools } from "./tools/register.ts";

export interface GeminiAcpRegistrar extends PiToolRegistrar, ModelAdapterRegistrar {
	getActiveTools?: () => string[];
	getAllTools?: () => Array<{ name: string }>;
	registerCommand?: PiCommandRegistrar["registerCommand"];
}

export interface GeminiAcpExtensionState {
	piScraper: PiScraperPresence;
	/** Clean up all warm ACP child processes. Call during Pi shutdown. */
	disconnect?: () => Promise<void>;
}

export default async function registerPiGeminiAcpExtension(
	pi: GeminiAcpRegistrar,
): Promise<GeminiAcpExtensionState> {
	registerGeminiAcpTools(pi);
	if (hasCommandRegistrar(pi)) registerGeminiAcpCommands(pi);
	// Create an abort controller scoped to this session's prewarm lifecycle.
	// Aborting it on session_shutdown cancels any in-flight prewarm subprocess.
	const prewarmAbort = new AbortController();

	// Wire ACP subprocess cleanup to Pi lifecycle events so cached Gemini ACP
	// process pairs are terminated when Pi exits, reloads, or switches sessions.
	// Without this, stale warm clients can accumulate as orphaned subprocesses.
	// Also tear down the prewarm so it cannot keep the Node.js event loop alive
	// past shutdown: if the schedule timer has not fired yet, cancel it; if the
	// prewarm is already in flight, abort its subprocess via the AbortController.
	let cancelPrewarmSchedule: (() => void) | undefined;
	(pi as unknown as ExtensionAPI).on("session_shutdown", async () => {
		prewarmAbort.abort();
		cancelPrewarmSchedule?.();
		await closeGeminiAcpClientCache();
	});

	// Recursion guard: Gemini CLI's run_shell_command tool may autonomously invoke `pi`
	// subcommands (e.g. `pi mcp list`), which re-loads this extension inside the Gemini
	// subprocess. Gemini-spawned children carry GEMINI_CLI=1. To break the recursive ACP
	// spawn cycle, skip every activation path that could spawn another `gemini --acp`
	// process (model adapter, model provider with its auth probe, prewarms, retention
	// sweep). Tools and commands remain registered so `pi mcp list` still surfaces the
	// extension's tool inventory inside the nested process.
	if (process.env.GEMINI_CLI === "1") return { piScraper: detectPiScraper(pi) };
	registerModelAdapter(pi);
	cancelPrewarmSchedule = scheduleGeminiSearchPrewarm({ signal: prewarmAbort.signal });
	scheduleCacheRetentionSweep();
	if (hasModelProviderRegistrar(pi)) {
		try {
			// Pi resolves startup model scopes after awaiting async extension factories. Register
			// the ACP provider before this factory resolves so startup patterns such as
			// "gemini-acp/gemini-3.1-pro-preview" see the provider's models immediately.
			await registerGeminiAcpModelProvider(pi);
		} catch (reason) {
			// Best-effort provider registration — log failure so it's visible in Pi output.
			// oxlint-disable-next-line no-console -- registration failure must surface to the user
			console.error("[pi-gemini-acp] Model provider registration failed:", reason);
		}
	}
	const removeProcessHandlers = setupShutdownHooks();
	return {
		piScraper: detectPiScraper(pi),
		disconnect: async () => {
			removeProcessHandlers();
			await closeGeminiAcpClientCache();
		},
	};
}

/** The parts of `process` used by the shutdown hooks; replaceable in tests. */
export interface ShutdownProcess {
	pid: number;
	on(signal: ShutdownSignal, handler: (signal: ShutdownSignal) => void): unknown;
	off(signal: ShutdownSignal, handler: (signal: ShutdownSignal) => void): unknown;
	listenerCount(signal: ShutdownSignal): number;
	kill(pid: number, signal: ShutdownSignal): unknown;
}

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Registers process signal handlers that clean up ACP child processes on Pi exit.
 *
 * Node skips its default "terminate on signal" behavior while any listener is registered. When this
 * hook is the only listener, it re-raises the signal after cleanup so the process still terminates.
 * When Pi or another extension also listens, that listener decides what the signal means (Pi's
 * interactive mode handles SIGINT itself), so the signal is not re-raised: doing so would run the
 * other listener twice and still not terminate the process.
 */
export function setupShutdownHooks(
	proc: ShutdownProcess = process,
	closeCache: () => Promise<void> = closeGeminiAcpClientCache,
): () => void {
	let shuttingDown = false;
	const handler = (signal: ShutdownSignal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		const othersHandleSignal = proc.listenerCount(signal) > 1;
		void closeCache()
			.catch(() => {
				// Preserve the original signal's termination behavior even if cleanup fails.
			})
			.finally(() => {
				if (othersHandleSignal) {
					// The process may keep running; let a later signal clean up again.
					shuttingDown = false;
					return;
				}
				for (const registeredSignal of SHUTDOWN_SIGNALS) proc.off(registeredSignal, handler);
				proc.kill(proc.pid, signal);
			});
	};
	for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, handler);
	return () => {
		for (const signal of SHUTDOWN_SIGNALS) proc.off(signal, handler);
	};
}

function hasModelProviderRegistrar(
	pi: GeminiAcpRegistrar,
): pi is GeminiAcpRegistrar & ModelProviderRegistrar {
	return typeof (pi as unknown as ModelProviderRegistrar).registerProvider === "function";
}

function scheduleCacheRetentionSweep(): void {
	const timer = setTimeout(() => {
		void sweepResponseCacheRetention().catch(() => {
			// fire-and-forget
		});
	}, 0);
	timer.unref();
}

function hasCommandRegistrar(
	pi: GeminiAcpRegistrar,
): pi is GeminiAcpRegistrar & PiCommandRegistrar {
	return typeof pi.registerCommand === "function";
}
