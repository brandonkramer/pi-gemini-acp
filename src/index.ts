import type { PiCommandRegistrar } from "./commands/define.js";
import { registerGeminiAcpCommands } from "./commands/register.js";
import { detectPiScraper, type PiScraperPresence } from "./research/hydrate.js";
import type { PiToolRegistrar } from "./tools/define.js";
import { registerGeminiAcpTools } from "./tools/register.js";

export interface GeminiAcpRegistrar extends PiToolRegistrar {
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
	if (hasCommandRegistrar(pi)) registerGeminiAcpCommands(pi);
	return { piScraper: detectPiScraper(pi) };
}

function hasCommandRegistrar(
	pi: GeminiAcpRegistrar,
): pi is GeminiAcpRegistrar & PiCommandRegistrar {
	return typeof pi.registerCommand === "function";
}
