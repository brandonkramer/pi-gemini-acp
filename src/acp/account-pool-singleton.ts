import type { GeminiAcpConfig, GeminiAcpProviderSettings } from "../types.ts";
import { resolveAccountsConfig } from "./account-config.ts";
import { AccountPool } from "./account-pool.ts";
import type { GeminiAcpCommandSettings } from "./client.ts";
import { createFileCooldownStore } from "./cooldown-store.ts";
import { buildGeminiAcpCommandSettings } from "./settings.ts";

export function hasAccountPool(config: GeminiAcpConfig): boolean {
	return resolveAccountsConfig(config.providers?.accounts) !== undefined;
}

export async function executeWithAccountPool<T>(
	config: GeminiAcpConfig,
	settings: GeminiAcpProviderSettings | undefined,
	operation: (commandSettings: GeminiAcpCommandSettings) => Promise<T>,
	signal?: AbortSignal,
	rootDir?: string,
): Promise<T> {
	const resolved = resolveAccountsConfig(config.providers?.accounts);
	if (!resolved) {
		return await operation(buildGeminiAcpCommandSettings(settings));
	}
	const store = createFileCooldownStore({ rootDir });
	const pool = new AccountPool(resolved, store);
	await pool.loadPersistedCooldowns();
	return await pool.execute(async (accountEnv) => {
		const commandSettings = buildGeminiAcpCommandSettings(settings, accountEnv);
		return await operation(commandSettings);
	}, signal);
}

export async function getAccountPoolStatus(config: GeminiAcpConfig, rootDir?: string) {
	const resolved = resolveAccountsConfig(config.providers?.accounts);
	if (!resolved) return;
	const store = createFileCooldownStore({ rootDir });
	const pool = new AccountPool(resolved, store);
	await pool.loadPersistedCooldowns();
	return pool.getStatus();
}

/** Clears persisted cooldowns. Primarily useful for tests and manual reset via /gemini-config. */
export async function clearAccountPool(): Promise<void> {
	const store = createFileCooldownStore();
	await store.save(new Map());
}
