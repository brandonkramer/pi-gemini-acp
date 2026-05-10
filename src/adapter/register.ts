/**
 * @fileoverview Wires pi-gemini-acp into pi-scraper's pi:model-adapter protocol.
 */
import { createGeminiSummarizeAdapter } from "./gemini-summarize.js";
import { recordAdapterEmitted } from "./status.js";
import type { DiscoverPayload, ModelCapability, RegisteredAdapter } from "./types.js";

const ADAPTER_ID = "gemini-acp";
const PRIORITY = 50;
const CAPABILITIES: readonly ModelCapability[] = ["summarize"];

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
	recordAdapterEmitted();
	events.on("pi:model-adapter/discover", (payload: unknown) => {
		if (matchesDiscoverFilter(payload, CAPABILITIES, PRIORITY)) {
			events.emit("pi:model-adapter/register", entry);
		}
	});
}

function matchesDiscoverFilter(
	payload: unknown,
	capabilities: readonly ModelCapability[],
	priority: number,
): boolean {
	if (!payload || typeof payload !== "object") return true;
	const discover = payload as DiscoverPayload;
	if (!discover.filter) return true;

	const requiredCapabilities = discover.filter.capabilities;
	if (requiredCapabilities && Array.isArray(requiredCapabilities)) {
		const hasOverlap = requiredCapabilities.some((cap) =>
			capabilities.includes(cap),
		);
		if (!hasOverlap) return false;
	}

	const minPriority = discover.filter.minPriority;
	if (typeof minPriority === "number" && !Number.isNaN(minPriority)) {
		if (priority < minPriority) return false;
	}

	return true;
}
