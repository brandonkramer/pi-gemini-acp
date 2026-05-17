import { homedir } from "node:os";
import path from "node:path";

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
	if (config.entries.length === 0) return undefined;
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
		.map((entry) => ({ name: entry.name, env: expandEnvValues(entry.env ?? {}) }));
}

function expandEnvValues(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [key, expandEnvValue(value, process.env)]),
	);
}

export function expandEnvValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value.replaceAll(/\$([A-Z_][A-Z0-9_]*)|%([^%]+)%/giu, (match, unix, win) => {
		const name = (unix ?? win) as string;
		const resolved = env[name];
		return typeof resolved === "string" ? resolved : match;
	});
}

/** Returns the first enabled account env for startup paths that do not rotate accounts. */
export function primaryAccountEnv(
	config: AccountsConfig | undefined,
): Record<string, string> | undefined {
	return resolveAccountsConfig(config)?.entries[0]?.env;
}

function resolveFailoverConfig(config?: AccountFailoverConfig): ResolvedFailoverConfig {
	return {
		retries: config?.retries ?? DEFAULT_FAILOVER_CONFIG.retries,
		codes: config?.codes ?? [...DEFAULT_FAILOVER_CONFIG.codes],
		coolDownSeconds: config?.coolDownSeconds ?? DEFAULT_FAILOVER_CONFIG.coolDownSeconds,
	};
}
