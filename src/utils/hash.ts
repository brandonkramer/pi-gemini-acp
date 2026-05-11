/** @file Shared hashing and stable serialization helpers. */
import { createHash } from "node:crypto";

/** Computes a SHA-256 hex digest for cache keys and source hashes. */
export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON encoder that sorts object keys and omits undefined/function values. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === undefined || typeof value === "function") return undefined;
	if (value === null || typeof value !== "object") return value;
	// oxlint-disable-next-line unicorn/no-array-callback-reference -- canonicalize takes one arg
	if (Array.isArray(value)) return value.map(canonicalize);
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).toSorted()) {
		const next = canonicalize(input[key]);
		if (next !== undefined) output[key] = next;
	}
	return output;
}
