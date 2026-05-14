/** @file Tests for model-label resolution and API-key fallback normalization. */
import { describe, expect, it } from "vitest";

import { apiModelFromLabel } from "../model-label.ts";

describe("apiModelFromLabel", () => {
	it("maps the display sentinel to the configured fallback model", () => {
		expect(apiModelFromLabel("Gemini ACP default")).toBe("gemini-3.1-flash-preview");
	});

	it("passes a plain model id through unchanged", () => {
		expect(apiModelFromLabel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
		expect(apiModelFromLabel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
	});

	it("strips a leading 'models/' prefix", () => {
		expect(apiModelFromLabel("models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
		expect(apiModelFromLabel("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
	});

	it("strips the prefix even after sentinel mapping does not apply", () => {
		expect(apiModelFromLabel("models/some-custom-model")).toBe("some-custom-model");
	});

	it("does not strip 'models/' from the middle of a string", () => {
		expect(apiModelFromLabel("custom/models/something")).toBe("custom/models/something");
	});
});
