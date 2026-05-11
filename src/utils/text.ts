/** @file Shared text manipulation and formatting helpers. */

/** Safely truncates text without exceeding the requested character count. */
export function truncateToolText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Pretty-prints a value as indented JSON. */
export function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? "undefined";
}
