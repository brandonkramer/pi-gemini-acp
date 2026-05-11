import { constants } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	type CommandAccess,
	geminiAcpCommandNotFoundMessage,
	resolveGeminiAcpCommand,
	spawnCommandForGeminiAcpResolution,
} from "../command.ts";

describe("Gemini ACP command resolution", () => {
	it("resolves POSIX commands from PATH with execute checks", async () => {
		const access = accessFor(["/opt/bin/gemini"]);
		const resolution = await resolveGeminiAcpCommand("gemini", {
			env: { PATH: "/usr/bin:/opt/bin" },
			platform: "linux",
			access,
		});

		expect(resolution).toMatchObject({
			found: true,
			command: "/opt/bin/gemini",
			source: "path",
		});
		expect(access.modes).toContain(constants.X_OK);
	});

	it("resolves explicit Windows paths without PATH lookup", async () => {
		const command = "C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd";
		const access = accessFor([command]);
		const resolution = await resolveGeminiAcpCommand(command, {
			env: { PATH: "C:\\unused" },
			platform: "win32",
			access,
		});

		expect(resolution).toMatchObject({
			found: true,
			command,
			source: "explicit-path",
		});
		expect(resolution.searched).toEqual([command]);
	});

	it("honors Windows PATHEXT and prefers npm .cmd shims for bare gemini", async () => {
		const command = "C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.CMD";
		const access = accessFor([command]);
		const resolution = await resolveGeminiAcpCommand("gemini", {
			env: {
				Path: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm",
				PATHEXT: ".EXE;.CMD;.BAT",
			},
			platform: "win32",
			access,
		});

		expect(resolution.found).toBe(true);
		expect(resolution.command).toBe(command);
		expect(resolution.searched).toContain(command);
		expect(access.modes).toContain(constants.F_OK);
	});

	it("wraps Windows .cmd shims with cmd.exe for spawning", () => {
		const spawnCommand = spawnCommandForGeminiAcpResolution(
			{
				input: "gemini",
				found: true,
				// Space-in-path stress case: prevents regressions to unquoted shim paths.
				command: "C:\\Users\\me\\AppData Roaming\\npm\\gemini.cmd",
				source: "path",
				platform: "win32",
				searched: [],
			},
			["--acp", "--model", "gemini-3.1-pro-preview"],
		);

		expect(path.win32.basename(spawnCommand.command).toLowerCase()).toBe("cmd.exe");
		expect(spawnCommand.args).toEqual([
			"/d",
			"/s",
			"/c",
			"call",
			'"C:\\Users\\me\\AppData Roaming\\npm\\gemini.cmd"',
			'"--acp"',
			'"--model"',
			'"gemini-3.1-pro-preview"',
		]);
		expect(spawnCommand.windowsVerbatimArguments).toBe(true);
	});

	it("keeps Scoop npm shim quoting compatible with cmd.exe", () => {
		const spawnCommand = spawnCommandForGeminiAcpResolution(
			{
				input: "gemini",
				found: true,
				command: "C:\\Users\\Administrator\\scoop\\apps\\nodejs\\current\\bin\\gemini.CMD",
				source: "path",
				platform: "win32",
				searched: [],
			},
			["--acp", "--help"],
		);

		expect(spawnCommand.args).toEqual([
			"/d",
			"/s",
			"/c",
			"call",
			'"C:\\Users\\Administrator\\scoop\\apps\\nodejs\\current\\bin\\gemini.CMD"',
			'"--acp"',
			'"--help"',
		]);
		expect(spawnCommand.args.join(" ")).not.toContain('\\"');
		expect(spawnCommand.windowsVerbatimArguments).toBe(true);
	});

	it("returns actionable Windows diagnostics when command resolution fails", async () => {
		const resolution = await resolveGeminiAcpCommand("gemini", {
			env: { PATH: "C:\\Windows", PATHEXT: ".EXE;.CMD" },
			platform: "win32",
			access: accessFor([]),
		});

		expect(resolution.found).toBe(false);
		expect(geminiAcpCommandNotFoundMessage(resolution)).toContain("where gemini");
		expect(geminiAcpCommandNotFoundMessage(resolution)).toContain("gemini.cmd");
	});
});

function accessFor(found: readonly string[]): CommandAccess & { modes: number[] } {
	const normalized = new Set(found.map((candidate) => candidate.toLowerCase()));
	const access = (async (candidate: string, mode: number) => {
		access.modes.push(mode);
		if (!normalized.has(candidate.toLowerCase())) throw new Error("missing");
	}) as CommandAccess & { modes: number[] };
	access.modes = [];
	return access;
}
