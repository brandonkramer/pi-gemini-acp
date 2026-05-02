import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	ensureDir,
	resolveStoragePaths,
	type StorageOptions,
} from "../storage/paths.js";
import type { GeminiAcpConfig, GeminiAcpProviderSettings } from "../types.js";

const CONFIG_FILE = "settings.json";

export async function loadConfig(
	options: StorageOptions = {},
): Promise<GeminiAcpConfig> {
	const filePath = path.join(resolveStoragePaths(options).config, CONFIG_FILE);
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as GeminiAcpConfig;
	} catch {
		return {};
	}
}

export async function saveGeminiAcpSettings(
	settings: GeminiAcpProviderSettings,
	options: StorageOptions = {},
): Promise<GeminiAcpConfig> {
	const paths = resolveStoragePaths(options);
	await ensureDir(paths.config);
	const current = await loadConfig(options);
	const config: GeminiAcpConfig = {
		...current,
		providers: {
			...current.providers,
			"gemini-acp": {
				...current.providers?.["gemini-acp"],
				...settings,
			},
		},
	};
	await writeFile(
		path.join(paths.config, CONFIG_FILE),
		JSON.stringify(config, null, 2),
		{ mode: 0o600 },
	);
	return config;
}

export function configFromEnv(config: GeminiAcpConfig): GeminiAcpConfig {
	const command = process.env.PI_GEMINI_ACP_COMMAND;
	const args = process.env.PI_GEMINI_ACP_ARGS?.split(" ").filter(Boolean);
	if (!command && !args) return config;
	return {
		...config,
		providers: {
			...config.providers,
			"gemini-acp": {
				...config.providers?.["gemini-acp"],
				enabled: true,
				command: command ?? config.providers?.["gemini-acp"]?.command,
				args: args ?? config.providers?.["gemini-acp"]?.args,
			},
		},
	};
}
