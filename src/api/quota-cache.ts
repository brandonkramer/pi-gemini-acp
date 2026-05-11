/** @file Tracks Gemini quota exhaustion to skip ACP when exhausted and fall back to API key. */

const QUOTA_EXHAUSTED_RE = /exhausted\s+your\s+capacity|quota\s+exhausted/iu;
const RESET_TIMER_RE = /quota\s+will\s+reset\s+after\s+([\dhms]+)/iu;
const HOUR_MS = 60 * 60 * 1000;

export interface QuotaExhaustionEntry {
	exhaustedAt: number;
	resetAfterMs?: number;
	model?: string;
}

const cache = new Map<string, QuotaExhaustionEntry>();

/** Extracts the reset duration in ms from a Gemini quota error message. */
export function parseQuotaResetMs(message: string): number | undefined {
	const match = RESET_TIMER_RE.exec(message);
	if (!match) return undefined;
	return parseDurationMs(match[1]);
}

/** Returns true if the error text indicates a Gemini quota/capacity exhaustion. */
export function isQuotaExhaustedError(error: unknown): boolean {
	const text = extractErrorText(error);
	return QUOTA_EXHAUSTED_RE.test(text);
}

/** Records that a model's quota is exhausted, with optional reset time. */
export function recordQuotaExhausted(model: string, message: string): void {
	const resetMs = parseQuotaResetMs(message);
	cache.set(model, {
		exhaustedAt: Date.now(),
		resetAfterMs: resetMs,
		model,
	});
}

/** Returns true if the given model is known to be exhausted and within the reset window. */
export function isQuotaExhausted(model: string): boolean {
	const entry = cache.get(model);
	if (!entry) return false;
	const elapsed = Date.now() - entry.exhaustedAt;
	// If we know the reset time and it has passed, clear and return false
	if (entry.resetAfterMs && elapsed >= entry.resetAfterMs) {
		cache.delete(model);
		return false;
	}
	// Otherwise exhausted if within 1-hour re-check window
	return elapsed < HOUR_MS;
}

/** Clears the quota exhaustion cache (for tests or manual reset). */
export function clearQuotaExhaustedCache(): void {
	cache.clear();
}

/** Returns a copy of current quota entries for diagnostics. */
export function getQuotaExhaustedEntries(): QuotaExhaustionEntry[] {
	return [...cache.values()];
}

function extractErrorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof (error as { message?: unknown }).message === "string"
	) {
		return (error as { message: string }).message;
	}
	return "";
}

function parseDurationMs(text: string): number | undefined {
	let total = 0;
	const hMatch = /(\d+)h/iu.exec(text);
	const mMatch = /(\d+)m/iu.exec(text);
	const sMatch = /(\d+)s/iu.exec(text);
	if (hMatch) total += parseInt(hMatch[1], 10) * 60 * 60 * 1000;
	if (mMatch) total += parseInt(mMatch[1], 10) * 60 * 1000;
	if (sMatch) total += parseInt(sMatch[1], 10) * 1000;
	return total > 0 ? total : undefined;
}
