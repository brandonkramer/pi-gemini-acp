import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, resolveStoragePaths, type StorageOptions } from "../storage/paths.ts";
import type {
	GeminiAcpChatSettings,
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
} from "../types.ts";

const CONFIG_FILE = "settings.json";

export const DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS = {
	enabled: true,
	command: "gemini",
	args: ["--acp"],
	authenticated: true,
	searchGroundingAvailable: true,
} satisfies GeminiAcpProviderSettings;

export async function loadConfig(options: StorageOptions = {}): Promise<GeminiAcpConfig> {
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
	await writeFile(path.join(paths.config, CONFIG_FILE), JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
	return config;
}

/** Persists the local opt-in/out switch for FTS recall. */
export async function saveRecallEnabled(
	recallEnabled: boolean,
	options: StorageOptions = {},
): Promise<GeminiAcpConfig> {
	const paths = resolveStoragePaths(options);
	await ensureDir(paths.config);
	const config: GeminiAcpConfig = {
		...(await loadConfig(options)),
		recallEnabled,
	};
	await writeFile(path.join(paths.config, CONFIG_FILE), JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
	return config;
}

/** Persists the provided chat-preamble settings under providers["gemini-acp"].chat. */
export async function saveChatSettings(
	chat: GeminiAcpChatSettings,
	options: StorageOptions = {},
	current?: GeminiAcpConfig,
): Promise<GeminiAcpConfig> {
	const paths = resolveStoragePaths(options);
	await ensureDir(paths.config);
	const base = current ?? (await loadConfig(options));
	const provider = base.providers?.["gemini-acp"] ?? {};
	const config: GeminiAcpConfig = {
		...base,
		providers: {
			...base.providers,
			"gemini-acp": { ...provider, chat } as GeminiAcpProviderSettings,
		},
	};
	await writeFile(path.join(paths.config, CONFIG_FILE), JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
	return config;
}

/** Removes the chat-preamble block from providers["gemini-acp"]. */
export async function clearChatSettings(
	options: StorageOptions = {},
	current?: GeminiAcpConfig,
): Promise<GeminiAcpConfig> {
	const paths = resolveStoragePaths(options);
	await ensureDir(paths.config);
	const base = current ?? (await loadConfig(options));
	const provider = base.providers?.["gemini-acp"] ?? {};
	const { chat: _, ...rest } = provider;
	const config: GeminiAcpConfig = {
		...base,
		providers: {
			...base.providers,
			"gemini-acp": rest as GeminiAcpProviderSettings,
		},
	};
	await writeFile(path.join(paths.config, CONFIG_FILE), JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
	return config;
}

/** Returns whether local recall is enabled. */
export function recallEnabledFromConfig(config: GeminiAcpConfig): boolean {
	if (process.env.PI_GEMINI_ACP_RECALL === "0") return false;
	return config.recallEnabled !== false;
}

export function configFromEnv(config: GeminiAcpConfig): GeminiAcpConfig {
	const command = process.env.PI_GEMINI_ACP_COMMAND;
	const args = process.env.PI_GEMINI_ACP_ARGS?.split(" ").filter(Boolean);
	const apiKey = process.env.GEMINI_API_KEY?.trim();
	const hasEnvOverrides = command ?? args ?? apiKey;
	if (!hasEnvOverrides) return config;
	return {
		...config,
		providers: {
			...config.providers,
			"gemini-acp": {
				...config.providers?.["gemini-acp"],
				enabled: true,
				command: command ?? config.providers?.["gemini-acp"]?.command,
				args: args ?? config.providers?.["gemini-acp"]?.args,
				apiKey: apiKey ?? config.providers?.["gemini-acp"]?.apiKey,
			},
		},
	};
}

export function withDefaultGeminiAcpConfig(config: GeminiAcpConfig): GeminiAcpConfig {
	const configured = config.providers?.["gemini-acp"];
	if (configured?.enabled === false) return config;
	return {
		...config,
		providers: {
			...config.providers,
			"gemini-acp": {
				...DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS,
				args: [...DEFAULT_GEMINI_ACP_PROVIDER_SETTINGS.args],
				...configured,
			},
		},
	};
}
