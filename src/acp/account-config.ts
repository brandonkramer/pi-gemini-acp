import type { AccountEntry, AccountFailoverConfig, AccountsConfig } from "../types.ts";

export interface ResolvedFailoverConfig {
	retries: number;
	codes: number[];
	coolDownSeconds: number;
}

export interface ResolvedAccountEntry {
	name: string;
	env: Record<string, string>;
}

export interface ResolvedAccountsConfig {
	failover: ResolvedFailoverConfig;
	entries: ResolvedAccountEntry[];
}

export const DEFAULT_FAILOVER_CONFIG: ResolvedFailoverConfig = {
	retries: 3,
	codes: [429],
	coolDownSeconds: 600,
};

export function resolveAccountsConfig(
	config: AccountsConfig | undefined,
): ResolvedAccountsConfig | undefined {
	if (!config) return undefined;
	if (!config.entries.length) return undefined;
	const entries = resolveEnabledAccounts(config.entries);
	if (entries.length === 0) return undefined;
	return {
		failover: resolveFailoverConfig(config.failover),
		entries,
	};
}

export function resolveEnabledAccounts(entries: AccountEntry[]): ResolvedAccountEntry[] {
	return entries
		.filter((entry) => entry.enabled !== false)
		.map((entry) => ({ name: entry.name, env: entry.env }));
}

function resolveFailoverConfig(config?: AccountFailoverConfig): ResolvedFailoverConfig {
	return {
		retries: config?.retries ?? DEFAULT_FAILOVER_CONFIG.retries,
		codes: config?.codes ?? [...DEFAULT_FAILOVER_CONFIG.codes],
		coolDownSeconds: config?.coolDownSeconds ?? DEFAULT_FAILOVER_CONFIG.coolDownSeconds,
	};
}
