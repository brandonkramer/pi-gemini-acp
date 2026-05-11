import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { geminiCliTrustedFoldersPath, trustGeminiCliFolder } from "../gemini-cli-trust.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-trust-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("Gemini CLI trusted folders", () => {
	it("uses Gemini CLI trusted folders path env override", () => {
		const trustPath = path.join(rootDir, "trustedFolders.json");
		expect(geminiCliTrustedFoldersPath({ GEMINI_CLI_TRUSTED_FOLDERS_PATH: trustPath })).toBe(
			trustPath,
		);
	});

	it("persists exact TRUST_FOLDER without broad skip-trust args", async () => {
		const trustPath = path.join(rootDir, "trustedFolders.json");
		const folder = path.join(rootDir, "docs");

		const result = await trustGeminiCliFolder(folder, {
			GEMINI_CLI_TRUSTED_FOLDERS_PATH: trustPath,
		});

		expect(result).toMatchObject({
			folderPath: folder,
			trustedFoldersPath: trustPath,
			trustLevel: "TRUST_FOLDER",
		});
		expect(JSON.parse(await readFile(trustPath, "utf8"))).toEqual({
			[folder]: "TRUST_FOLDER",
		});
	});

	it("preserves existing valid trust rules", async () => {
		const trustPath = path.join(rootDir, "trustedFolders.json");
		const existing = path.join(rootDir, "existing");
		const folder = path.join(rootDir, "docs");
		await writeFile(
			trustPath,
			JSON.stringify({ [existing]: "DO_NOT_TRUST", bad: "INVALID" }),
			"utf8",
		);

		await trustGeminiCliFolder(folder, {
			GEMINI_CLI_TRUSTED_FOLDERS_PATH: trustPath,
		});

		expect(JSON.parse(await readFile(trustPath, "utf8"))).toEqual({
			[existing]: "DO_NOT_TRUST",
			[folder]: "TRUST_FOLDER",
		});
	});
});
