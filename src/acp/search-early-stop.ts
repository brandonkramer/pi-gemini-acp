/** @file Stream parsing and optional early-stop for Gemini ACP search. */
import type { GeminiAcpPromptUpdateHandler } from "./client.ts";

const SEARCH_EARLY_STOP_ENV = "PI_GEMINI_ACP_SEARCH_EARLY_STOP";
const TRUE_ENV_RE = /^(?:1|true|yes)$/iu;

/** Search-stream early-stop state shared by stdio and cached ACP search paths. */
export interface GeminiAcpSearchEarlyStop {
	signal?: AbortSignal;
	onUpdate?: GeminiAcpPromptUpdateHandler;
	parsedPayload(): unknown | undefined;
	stopped(): boolean;
}

/** Returns whether Gemini ACP search stream early-stop is enabled for this process. */
export function geminiAcpSearchEarlyStopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return TRUE_ENV_RE.test(env[SEARCH_EARLY_STOP_ENV] ?? "");
}

/** Builds an update wrapper that aborts once a complete top-level JSON array appears. */
export function createGeminiAcpSearchEarlyStop(
	onUpdate?: GeminiAcpPromptUpdateHandler,
	env: NodeJS.ProcessEnv = process.env,
): GeminiAcpSearchEarlyStop {
	if (!geminiAcpSearchEarlyStopEnabled(env)) {
		return {
			onUpdate,
			parsedPayload: () => undefined,
			stopped: () => false,
		};
	}
	const controller = new AbortController();
	let parsedPayload: unknown;
	let scanStart = 0;
	let stopped = false;
	return {
		signal: controller.signal,
		onUpdate: async (chunk) => {
			await onUpdate?.(chunk);
			if (stopped) return;
			const detected = completeJsonArrayPayload(chunk.accumulatedText, scanStart);
			if (!detected.found) {
				scanStart = detected.retryFrom;
				return;
			}
			parsedPayload = detected.payload;
			stopped = true;
			controller.abort();
		},
		parsedPayload: () => parsedPayload,
		stopped: () => stopped,
	};
}

export type GeminiAcpSearchJsonScanResult =
	| { found: true; payload: unknown; retryFrom: number }
	| { found: false; retryFrom: number };

/** Finds and parses the first complete JSON array in streamed assistant text. */
export function completeJsonArrayPayload(text: string, startAt = 0): GeminiAcpSearchJsonScanResult {
	const initialStart = Math.max(0, Math.min(startAt, text.length));
	for (
		let start = text.indexOf("[", initialStart);
		start >= 0;
		start = text.indexOf("[", start + 1)
	) {
		const end = completeJsonArrayEnd(text, start);
		if (end === undefined) return { found: false, retryFrom: start };
		try {
			return {
				found: true,
				payload: JSON.parse(text.slice(start, end + 1)),
				retryFrom: end + 1,
			};
		} catch {
			/* A markdown/link-style bracket can precede the real JSON array. */
		}
	}
	return { found: false, retryFrom: text.length };
}

function completeJsonArrayEnd(text: string, start: number): number | undefined {
	let arrayDepth = 0;
	let objectDepth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "[") arrayDepth += 1;
		else if (char === "]") arrayDepth -= 1;
		else if (char === "{") objectDepth += 1;
		else if (char === "}") objectDepth -= 1;
		if (arrayDepth < 0 || objectDepth < 0) return undefined;
		if (arrayDepth === 0 && objectDepth === 0) return index;
	}
	return undefined;
}
