/** @file Shared formatting helpers for human-readable output. */

/** Formats a millisecond duration as a concise age string (e.g. "5m", "2h"). */
export function formatAge(ageMs: number): string {
	if (ageMs < 60_000) return `${Math.max(0, Math.round(ageMs / 1000))}s`;
	if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
	if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h`;
	return `${Math.round(ageMs / 86_400_000)}d`;
}
