import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/** Checks whether a configured local ACP command is executable by the current user. */
export type CommandExists = (command: string) => Promise<boolean>;

/** Filesystem access probe used to make command resolution deterministic in tests. */
export type CommandAccess = (candidate: string, mode: number) => Promise<void>;

/** Result of resolving a user-provided Gemini ACP command to a spawnable local executable. */
export interface GeminiAcpCommandResolution {
	input: string;
	found: boolean;
	command?: string;
	source: "explicit-path" | "path" | "not-found";
	platform: NodeJS.Platform;
	searched: string[];
}

/** Options for resolving a command without depending on the host process in tests. */
export interface GeminiAcpCommandResolutionOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	access?: CommandAccess;
}

/** Command and arguments safe to pass to Node's child_process spawn/execFile APIs. */
export interface GeminiAcpSpawnCommand {
	command: string;
	args: string[];
}

/** Resolves a Gemini ACP command using PATH, including Windows PATHEXT npm shims. */
export async function resolveGeminiAcpCommand(
	command: string,
	options: GeminiAcpCommandResolutionOptions = {},
): Promise<GeminiAcpCommandResolution> {
	const input = command.trim();
	const platform = options.platform ?? process.platform;
	const pathApi = platform === "win32" ? path.win32 : path;
	const searched: string[] = [];
	if (!input)
		return { input, found: false, source: "not-found", platform, searched };
	const canAccess = options.access ?? access;
	const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
	if (isPathLikeCommand(input, platform)) {
		const candidate = pathApi.resolve(input);
		searched.push(candidate);
		return (await isExecutable(candidate, mode, canAccess))
			? {
					input,
					found: true,
					command: candidate,
					source: "explicit-path",
					platform,
					searched,
				}
			: { input, found: false, source: "not-found", platform, searched };
	}
	for (const dir of pathEntries(options.env ?? process.env, platform)) {
		for (const name of commandCandidateNames(
			input,
			options.env ?? process.env,
			platform,
		)) {
			const candidate = pathApi.join(dir, name);
			if (searched.includes(candidate)) continue;
			searched.push(candidate);
			if (await isExecutable(candidate, mode, canAccess)) {
				return {
					input,
					found: true,
					command: candidate,
					source: "path",
					platform,
					searched,
				};
			}
		}
	}
	return { input, found: false, source: "not-found", platform, searched };
}

/** Checks whether a Gemini ACP command can be resolved for the current process. */
export async function defaultGeminiAcpCommandExists(
	command: string,
): Promise<boolean> {
	return (await resolveGeminiAcpCommand(command)).found;
}

/** Builds a spawn command, wrapping Windows .cmd/.bat shims through cmd.exe. */
export function spawnCommandForGeminiAcpResolution(
	resolution: GeminiAcpCommandResolution,
	args: readonly string[] = [],
): GeminiAcpSpawnCommand {
	if (!resolution.found || !resolution.command) {
		throw new Error(geminiAcpCommandNotFoundMessage(resolution));
	}
	if (resolution.platform === "win32" && isWindowsCmdShim(resolution.command)) {
		return {
			command: commandProcessor(process.env),
			args: ["/d", "/s", "/c", cmdCommandLine(resolution.command, args)],
		};
	}
	return { command: resolution.command, args: [...args] };
}

/** Explains how command resolution failed without leaking unrelated environment values. */
export function geminiAcpCommandNotFoundMessage(
	resolution: GeminiAcpCommandResolution,
): string {
	const searched = resolution.searched.length;
	const windowsHint =
		resolution.platform === "win32"
			? " Checked Windows PATH/PATHEXT candidates such as .exe, .cmd, and .bat npm shims. Run `where gemini` or configure an absolute gemini.cmd path with `/gemini-config command <path> --acp --skip-trust`."
			: " Confirm the command is on PATH, or configure an absolute path with `/gemini-config command <path> --acp --skip-trust`.";
	return `Gemini ACP command '${resolution.input || "gemini"}' was not found from this Pi process. Searched ${searched} candidate${searched === 1 ? "" : "s"}.${windowsHint}`;
}

function isPathLikeCommand(
	command: string,
	platform: NodeJS.Platform,
): boolean {
	return (
		(platform === "win32" ? path.win32 : path).isAbsolute(command) ||
		command.includes("/") ||
		command.includes("\\")
	);
}

async function isExecutable(
	candidate: string,
	mode: number,
	canAccess: CommandAccess,
): Promise<boolean> {
	try {
		await canAccess(candidate, mode);
		return true;
	} catch {
		return false;
	}
}

function pathEntries(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): string[] {
	const value = envValue(env, "PATH", platform);
	return (value ?? "")
		.split(platform === "win32" ? ";" : path.delimiter)
		.filter(Boolean);
}

function commandCandidateNames(
	command: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): string[] {
	if (platform !== "win32") return [command];
	const ext = path.win32.extname(command);
	if (ext) return [command];
	const names = windowsExecutableExtensions(env).map(
		(suffix) => `${command}${suffix}`,
	);
	names.push(command);
	return [...new Set(names)];
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
	const raw = envValue(env, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD";
	const extensions = raw
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => extension && extension.toUpperCase() !== ".PS1");
	return extensions.length ? extensions : [".COM", ".EXE", ".BAT", ".CMD"];
}

function envValue(
	env: NodeJS.ProcessEnv,
	name: string,
	platform: NodeJS.Platform,
): string | undefined {
	if (platform !== "win32") return env[name];
	const key = Object.keys(env).find(
		(candidate) => candidate.toLowerCase() === name.toLowerCase(),
	);
	return key ? env[key] : undefined;
}

function isWindowsCmdShim(command: string): boolean {
	const extension = path.win32.extname(command).toLowerCase();
	return extension === ".cmd" || extension === ".bat";
}

function cmdCommandLine(command: string, args: readonly string[]): string {
	return [command, ...args].map(quoteCmdArg).join(" ");
}

function quoteCmdArg(value: string): string {
	return `"${value.replace(/["^&|<>()]/gu, "^$&").replace(/%/gu, "%%")}"`;
}

function commandProcessor(env: NodeJS.ProcessEnv): string {
	return env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
}
