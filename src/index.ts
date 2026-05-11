import { registerModelAdapter, type ModelAdapterRegistrar } from "./adapter/register.js";
import type { PiCommandRegistrar } from "./commands/define.js";
import { registerGeminiAcpCommands } from "./commands/register.js";
import { detectPiScraper, type PiScraperPresence } from "./research/hydrate.js";
import { scheduleGeminiSearchPrewarm } from "./search/prewarm.js";
import { sweepResponseCacheRetention } from "./storage/retention.js";
import type { PiToolRegistrar } from "./tools/define.js";
import { registerGeminiAcpTools } from "./tools/register.js";

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
