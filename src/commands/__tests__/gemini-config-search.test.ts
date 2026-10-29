import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { loadConfig, saveRecallEnabled } from "../../config/settings.ts";
import { runGeminiConfigSearch } from "../gemini-config-search.ts";
import { parseGeminiConfigCommandArgs } from "../gemini-config.ts";

afterEach(() => vi.unstubAllEnvs());

it("parses search actions and rejects extra arguments", () => {
	expect(parseGeminiConfigCommandArgs("search")).toEqual({
		action: "search",
		searchAction: "status",
	});
	for (const searchAction of ["status", "enable", "disable"]) {
		expect(parseGeminiConfigCommandArgs(`search ${searchAction}`)).toEqual({
			action: "search",
			searchAction,
		});
	}
	expect(() => parseGeminiConfigCommandArgs("search invalid")).toThrow("Expected search action");
	expect(() => parseGeminiConfigCommandArgs("search enable extra")).toThrow(
		"Expected search action",
	);
});

it("persists search settings, preserves other settings, and respects the environment override", async () => {
	const rootDir = await mkdtemp(path.join(os.tmpdir(), "gemini-search-config-"));
	try {
		vi.stubEnv("PI_GEMINI_ACP_SEARCH", "1");
		await saveRecallEnabled(false, { rootDir });
		await runGeminiConfigSearch({ searchAction: "disable" }, { rootDir });
		expect(await loadConfig({ rootDir })).toMatchObject({
			recallEnabled: false,
			searchEnabled: false,
		});
		await runGeminiConfigSearch({ searchAction: "enable" }, { rootDir });
		expect((await runGeminiConfigSearch({}, { rootDir })).details.data?.searchEnabled).toBe(true);
		vi.stubEnv("PI_GEMINI_ACP_SEARCH", "0");
		expect((await runGeminiConfigSearch({}, { rootDir })).details.data).toMatchObject({
			searchEnabled: false,
			envDisabled: true,
		});
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});
