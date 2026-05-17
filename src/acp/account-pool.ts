import { parseQuotaResetMs } from "../api/quota-cache.ts";
import type {
	ResolvedAccountEntry,
	ResolvedAccountsConfig,
	ResolvedFailoverConfig,
} from "./account-config.ts";
import type { CooldownStore } from "./cooldown-store.ts";

export interface CooldownEntry {
	accountName: string;
	coolUntil: number;
	reason: string;
}

export interface AccountPoolStatus {
	activeAccounts: string[];
	cooldowns: CooldownEntry[];
	totalAccounts: number;
}

export type AccountPoolOperation<T> = (accountEnv: Record<string, string>) => Promise<T>;

export class AccountPool {
	private readonly entries: ResolvedAccountEntry[];
	private readonly failover: ResolvedFailoverConfig;
	private readonly cooldownStore?: CooldownStore;
	private readonly cooldowns = new Map<string, CooldownEntry>();

	constructor(config: ResolvedAccountsConfig, cooldownStore?: CooldownStore) {
		this.entries = config.entries;
		this.failover = config.failover;
		this.cooldownStore = cooldownStore;
	}

	async loadPersistedCooldowns(): Promise<void> {
		if (!this.cooldownStore) return;
		const loaded = await this.cooldownStore.load();
		for (const [name, entry] of loaded) {
			this.cooldowns.set(name, entry);
		}
	}

	async execute<T>(operation: AccountPoolOperation<T>, signal?: AbortSignal): Promise<T> {
		const healthy = this.healthyAccounts();
		if (healthy.length === 0) {
			throw new AccountPoolExhaustedError(
				"All Gemini ACP accounts are exhausted or cooled down.",
				this.cooldowns,
			);
		}

		let lastError: unknown;
		for (let i = 0; i < healthy.length; i++) {
			const account = healthy[i];
			try {
				return await this.executeWithRetries(operation, account.env, account, signal);
			} catch (error) {
				lastError = error;
				if (signal?.aborted) throw error;
			}
		}

		throw new AccountPoolExhaustedError(
			"All Gemini ACP accounts are exhausted or cooled down.",
			this.cooldowns,
			{ cause: lastError },
		);
	}

	getStatus(): AccountPoolStatus {
		return {
			activeAccounts: this.healthyAccounts().map((e) => e.name),
			cooldowns: [...this.cooldowns.values()],
			totalAccounts: this.entries.length,
		};
	}

	recordCooldown(accountName: string, durationMs: number, reason?: string): void {
		this.cooldowns.set(accountName, {
			accountName,
			coolUntil: Date.now() + durationMs,
			reason: reason ?? "manually recorded",
		});
	}

	clearCooldowns(): void {
		this.cooldowns.clear();
		void this.cooldownStore?.save(this.cooldowns);
	}

	private async executeWithRetries<T>(
		operation: AccountPoolOperation<T>,
		env: Record<string, string>,
		account: ResolvedAccountEntry,
		signal?: AbortSignal,
	): Promise<T> {
		let lastError: unknown;
		const maxAttempts = 1 + this.failover.retries;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			try {
				return await operation(env);
			} catch (error) {
				lastError = error;
				if (signal?.aborted) throw error;
				if (!this.isRetryableOnSameAccount(error)) {
					await this.coolDownAccount(account, error);
					throw error;
				}
				if (attempt === maxAttempts - 1) {
					await this.coolDownAccount(account, error);
					throw error;
				}
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private isRetryableOnSameAccount(error: unknown): boolean {
		const statusCode = extractStatusCode(error);
		if (statusCode !== undefined) {
			return this.failover.codes.includes(statusCode);
		}
		const message = error instanceof Error ? error.message : String(error);
		// When the upstream error advertises a concrete quota reset window, retrying the same
		// account inside that window is guaranteed to fail; cool it down and fail over instead.
		if (parseQuotaResetMs(message) !== undefined) {
			return false;
		}
		return /exhausted|quota|capacity|rate.limit/iu.test(message);
	}

	private async coolDownAccount(account: ResolvedAccountEntry, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const parsedMs = parseQuotaResetMs(message);
		const durationMs = parsedMs ?? this.failover.coolDownSeconds * 1000;
		this.cooldowns.set(account.name, {
			accountName: account.name,
			coolUntil: Date.now() + durationMs,
			reason: message,
		});
		await this.cooldownStore?.save(this.cooldowns);
	}

	private healthyAccounts(): ResolvedAccountEntry[] {
		const now = Date.now();
		return this.entries.filter((entry) => {
			const cooldown = this.cooldowns.get(entry.name);
			if (!cooldown) return true;
			if (cooldown.coolUntil <= now) {
				this.cooldowns.delete(entry.name);
				return true;
			}
			return false;
		});
	}
}

export function allAccountsCooledDown(
	entries: ResolvedAccountEntry[],
	cooldowns: Map<string, CooldownEntry>,
): boolean {
	const now = Date.now();
	return entries.every((entry) => {
		const cooldown = cooldowns.get(entry.name);
		return cooldown !== undefined && cooldown.coolUntil > now;
	});
}

export class AccountPoolExhaustedError extends Error {
	readonly cooldowns: Map<string, CooldownEntry>;
	constructor(
		message: string,
		cooldowns: Map<string, CooldownEntry>,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "AccountPoolExhaustedError";
		this.cooldowns = new Map(cooldowns);
	}
}

function extractStatusCode(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as Record<string, unknown>;
	if (typeof record.statusCode === "number") return record.statusCode;
	if (typeof record.status === "number") return record.status;
	const message = record.message;
	if (typeof message === "string") {
		const match = /\((\d{3})\)/u.exec(message);
		if (match) return parseInt(match[1], 10);
	}
	return undefined;
}
