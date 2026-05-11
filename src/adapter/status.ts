/**
 * @file Tracks whether the model adapter was actually emitted during this process lifetime, and
 *   exposes the live status query used by gemini_status and /gemini-config.
 */
import type { ModelCapability } from "./types.ts";

const CAPABILITIES: readonly ModelCapability[] = ["summarize"];
const PRIORITY = 50;

let adapterEmitted = false;

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

/** Records that the adapter was emitted. Called by registerModelAdapter. */
export function recordAdapterEmitted(): void {
	adapterEmitted = true;
}

/** Resets the emitted flag; intended for test isolation only. */
export function resetModelAdapterEmitted(): void {
	adapterEmitted = false;
}
