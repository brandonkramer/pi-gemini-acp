/** @file Shared type guards and validation helpers used across tool and route modules. */

/** Narrows unknown values to non-array records for safe property access. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows unknown values to non-empty strings. */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
