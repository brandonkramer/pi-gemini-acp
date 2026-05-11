/** @file Unit tests for shared value-coercion helpers. */
import { describe, expect, it } from "vitest";

import { coerceEnum, coerceFiniteNumber, coerceString } from "../coerce.js";

describe("coerceString", () => {
	it("returns trimmed non-empty string", () => {
		expect(coerceString("hello")).toBe("hello");
		expect(coerceString("  hello  ")).toBe("hello");
	});

	it("returns undefined for empty or whitespace-only", () => {
		expect(coerceString("")).toBeUndefined();
		expect(coerceString("   ")).toBeUndefined();
	});

	it("returns undefined for non-string values", () => {
		expect(coerceString(undefined)).toBeUndefined();
		expect(coerceString(null)).toBeUndefined();
		expect(coerceString(42)).toBeUndefined();
		expect(coerceString(true)).toBeUndefined();
		expect(coerceString({})).toBeUndefined();
		expect(coerceString([])).toBeUndefined();
	});
});

describe("coerceFiniteNumber", () => {
	it("returns finite numbers", () => {
		expect(coerceFiniteNumber(0)).toBe(0);
		expect(coerceFiniteNumber(42)).toBe(42);
		expect(coerceFiniteNumber(-1.5)).toBe(-1.5);
	});

	it("returns undefined for non-finite numbers", () => {
		expect(coerceFiniteNumber(NaN)).toBeUndefined();
		expect(coerceFiniteNumber(Infinity)).toBeUndefined();
		expect(coerceFiniteNumber(-Infinity)).toBeUndefined();
	});

	it("returns undefined for non-number values", () => {
		expect(coerceFiniteNumber(undefined)).toBeUndefined();
		expect(coerceFiniteNumber(null)).toBeUndefined();
		expect(coerceFiniteNumber("3")).toBeUndefined();
		expect(coerceFiniteNumber(true)).toBeUndefined();
		expect(coerceFiniteNumber({})).toBeUndefined();
	});
});

describe("coerceEnum", () => {
	const ALLOWED = ["alpha", "beta", "gamma"] as const;

	it("returns value when it's in the allowed set", () => {
		expect(coerceEnum("alpha", ALLOWED)).toBe("alpha");
		expect(coerceEnum("beta", ALLOWED)).toBe("beta");
	});

	it("returns undefined for disallowed strings", () => {
		expect(coerceEnum("delta", ALLOWED)).toBeUndefined();
		expect(coerceEnum("", ALLOWED)).toBeUndefined();
	});

	it("returns undefined for non-string values", () => {
		expect(coerceEnum(undefined, ALLOWED)).toBeUndefined();
		expect(coerceEnum(null, ALLOWED)).toBeUndefined();
		expect(coerceEnum(1, ALLOWED)).toBeUndefined();
		expect(coerceEnum({}, ALLOWED)).toBeUndefined();
	});
});
