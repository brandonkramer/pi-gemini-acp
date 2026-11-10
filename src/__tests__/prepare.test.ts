import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("prepare", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-gemini-acp-prepare-"));
		await mkdir(join(directory, "scripts"));
		await copyFile(
			new URL("../../scripts/prepare.mjs", import.meta.url),
			join(directory, "scripts/prepare.mjs"),
		);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	function prepare() {
		return spawnSync(process.execPath, ["scripts/prepare.mjs"], {
			cwd: directory,
			encoding: "utf8",
			env: { ...process.env, NODE_PATH: "" },
		});
	}

	async function installLefthook(source: string) {
		const dependency = join(directory, "node_modules/lefthook");
		await mkdir(dependency, { recursive: true });
		await writeFile(join(dependency, "package.json"), JSON.stringify({ main: "index.cjs" }));
		await writeFile(join(dependency, "index.cjs"), source);
	}

	it("succeeds without Lefthook when development dependencies are omitted", () => {
		const result = prepare();
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("runs the local Lefthook CLI with install for development checkouts", async () => {
		await installLefthook("console.log(JSON.stringify(process.argv.slice(2)));");
		const result = prepare();
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe('["install"]');
	});

	it("propagates hook installation failures", async () => {
		await installLefthook('console.error("hook installation failed"); process.exit(23);');
		const result = prepare();
		expect(result.status).toBe(23);
		expect(result.stderr).toContain("hook installation failed");
	});

	it("does not hide errors resolving an installed Lefthook package", async () => {
		await installLefthook("");
		await writeFile(join(directory, "node_modules/lefthook/package.json"), "{");
		const result = prepare();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("ERR_INVALID_PACKAGE_CONFIG");
	});
});
