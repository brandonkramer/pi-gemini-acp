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
}

export default function registerPiGeminiAcpExtension(
	pi: GeminiAcpRegistrar,
): GeminiAcpExtensionState {
	registerGeminiAcpTools(pi);
	registerModelAdapter(pi);
	if (hasCommandRegistrar(pi)) registerGeminiAcpCommands(pi);
	scheduleGeminiSearchPrewarm();
	scheduleCacheRetentionSweep();
	if (hasModelProviderRegistrar(pi)) {
		void registerGeminiAcpModelProvider(pi).catch(() => {
			/* best-effort provider registration */
		});
	}
	return { piScraper: detectPiScraper(pi) };
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
