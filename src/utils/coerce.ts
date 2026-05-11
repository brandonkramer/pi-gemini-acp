/**
 * @file Value-coercion helpers used across the extension to safely extract typed values from
 *   unknown / external payloads.
 */

/** Returns trimmed non-empty string, or undefined. */
export function coerceString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	return undefined;
}

/** Returns finite number, or undefined. */
export function coerceFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

/** Returns value if it's one of the allowed literals, else undefined. */
export function coerceEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: undefined;
}
