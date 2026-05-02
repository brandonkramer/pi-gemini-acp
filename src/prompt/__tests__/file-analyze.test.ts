import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFileAnalyze } from "../file-analyze.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-file-analyze-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runFileAnalyze", () => {
	it("validates explicit files but reports unsupported ACP file transport", async () => {
		await writeFile(path.join(rootDir, "notes.txt"), "alpha beta", "utf8");

		const result = await runFileAnalyze({
			paths: ["notes.txt"],
			instructions: "Summarize this file.",
			cwd: rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE");
		expect(result.files).toEqual([
			expect.objectContaining({
				path: "notes.txt",
				resolvedPath: path.join(rootDir, "notes.txt"),
				sizeBytes: 10,
			}),
		]);
		expect(result.supported).toBe(false);
		expect(result.transport).toBe("unsupported");
	});

	it("rejects directories", async () => {
		await mkdir(path.join(rootDir, "docs"));

		const result = await runFileAnalyze({
			paths: ["docs"],
			instructions: "Analyze docs.",
			cwd: rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_FILE_ANALYZE_DIRECTORY_REJECTED");
		expect(result.files).toEqual([]);
	});

	it("rejects hidden paths by default", async () => {
		await writeFile(path.join(rootDir, ".env"), "TOKEN=secret", "utf8");

		const result = await runFileAnalyze({
			paths: [".env"],
			instructions: "Analyze this file.",
			cwd: rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_FILE_ANALYZE_HIDDEN_PATH_REJECTED");
	});

	it("rejects secret-like files by default before reading content", async () => {
		const result = await runFileAnalyze({
			paths: ["api-token.txt"],
			instructions: "Analyze this file.",
			cwd: rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_FILE_ANALYZE_SECRET_PATH_REJECTED");
	});
});
