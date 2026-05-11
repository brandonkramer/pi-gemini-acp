import { registerModelAdapter, type ModelAdapterRegistrar } from "./adapter/register.ts";
import type { PiCommandRegistrar } from "./commands/define.ts";
import { registerGeminiAcpCommands } from "./commands/register.ts";
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
	return { piScraper: detectPiScraper(pi) };
}

function scheduleCacheRetentionSweep(): void {
	const timer = setTimeout(() => {
		void sweepResponseCacheRetention().catch(() => undefined);
	}, 0);
	timer.unref?.();
}

function hasCommandRegistrar(
	pi: GeminiAcpRegistrar,
): pi is GeminiAcpRegistrar & PiCommandRegistrar {
	return typeof pi.registerCommand === "function";
}
