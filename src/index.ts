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
	registerModelAdapter(pi);
	if (hasCommandRegistrar(pi)) registerGeminiAcpCommands(pi);
	scheduleGeminiSearchPrewarm();
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
	const removeHandlers = setupShutdownHooks();
	return {
		piScraper: detectPiScraper(pi),
		disconnect: async () => {
			removeHandlers();
			await closeGeminiAcpClientCache();
		},
	};
}

/** Registers process signal handlers that clean up ACP child processes on Pi exit. */
function setupShutdownHooks(): () => void {
	let shuttingDown = false;
	const handler = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		void closeGeminiAcpClientCache();
	};
	process.on("SIGTERM", handler);
	process.on("SIGINT", handler);
	process.on("SIGHUP", handler);
	return () => {
		process.off("SIGTERM", handler);
		process.off("SIGINT", handler);
		process.off("SIGHUP", handler);
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
