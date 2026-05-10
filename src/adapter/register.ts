/**
 * @fileoverview Wires pi-gemini-acp into pi-scraper's pi:model-adapter protocol.
 */
import { createGeminiSummarizeAdapter } from "./summarize.js";
import type { ModelCapability, RegisteredAdapter } from "./types.js";

const ADAPTER_ID = "gemini-acp";
const PRIORITY = 50;
const CAPABILITIES: readonly ModelCapability[] = ["summarize"];

let adapterEmitted = false;

export interface ModelAdapterRegistrar {
	events?: {
		on(event: string, handler: (payload: unknown) => void): void;
		emit(event: string, payload: unknown): void;
	};
}

export function registerModelAdapter(pi: ModelAdapterRegistrar): void {
	if (process.env.PI_GEMINI_ACP_OFFER_MODEL_ADAPTER === "0") return;
	const events = pi.events;
	if (!events?.on || !events?.emit) return;

	const entry: RegisteredAdapter = {
		id: ADAPTER_ID,
		label: "Gemini (via ACP)",
		capabilities: [...CAPABILITIES],
		priority: PRIORITY,
		adapter: createGeminiSummarizeAdapter(),
	};

	events.emit("pi:model-adapter/register", entry);
	adapterEmitted = true;
	events.on("pi:model-adapter/discover", (_payload: unknown) => {
		events.emit("pi:model-adapter/register", entry);
	});
}

export function getModelAdapterStatus(): {
	offered: boolean;
	capabilities: ModelCapability[];
	priority: number;
} {
	return {
		offered: adapterEmitted,
		capabilities: [...CAPABILITIES],
		priority: PRIORITY,
	};
}

/** Resets the emitted flag; intended for test isolation only. */
export function resetModelAdapterEmitted(): void {
	adapterEmitted = false;
}
