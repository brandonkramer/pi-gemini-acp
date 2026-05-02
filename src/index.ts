import { detectPiScraper, type PiScraperPresence } from "./research/hydrate.js";
import type { PiToolRegistrar } from "./tools/define.js";
import { registerGeminiAcpTools } from "./tools/register.js";

export interface GeminiAcpRegistrar extends PiToolRegistrar {
	getActiveTools?: () => string[];
	getAllTools?: () => Array<{ name: string }>;
	registerCommand?: (name: string, options: unknown) => void;
}

export interface GeminiAcpExtensionState {
	piScraper: PiScraperPresence;
}

export default function registerPiGeminiAcpExtension(
	pi: GeminiAcpRegistrar,
): GeminiAcpExtensionState {
	registerGeminiAcpTools(pi);
	return { piScraper: detectPiScraper(pi) };
}
