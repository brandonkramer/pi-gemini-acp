import type { GeminiAcpPermissionPolicy, StructuredError } from "../types.ts";

export const GEMINI_ACP_PERMISSION_MODES = [
	"restrictive",
	"file-read",
	"file-read-write",
	"terminal",
] as const;

export type GeminiAcpPermissionMode = (typeof GEMINI_ACP_PERMISSION_MODES)[number];

export type PermissionPolicyDisplayMode = GeminiAcpPermissionMode | "custom";

export type PermissionCapability = "filesystemRead" | "filesystemWrite" | "terminal";

export interface ResolvedPermissionPolicy {
	mode: PermissionPolicyDisplayMode;
	filesystemRead: boolean;
	filesystemWrite: boolean;
	terminal: boolean;
	reason?: string;
	updatedAt?: string;
}

export interface AcpClientCapabilities {
	auth: { terminal: boolean };
	fs: { readTextFile: boolean; writeTextFile: boolean };
	terminal: boolean;
}

type LegacyPermissionPolicy = GeminiAcpPermissionPolicy & {
	mode?: GeminiAcpPermissionMode;
};

const DEFAULT_POLICY: ResolvedPermissionPolicy = {
	mode: "restrictive",
	filesystemRead: false,
	filesystemWrite: false,
	terminal: false,
};

/** Converts older mode-based policy records into the current capability flags. */
export function migrateLegacyPermissionPolicy(
	policy?: GeminiAcpPermissionPolicy,
): GeminiAcpPermissionPolicy | undefined {
	if (!policy) return undefined;
	const legacyMode = (policy as LegacyPermissionPolicy).mode;
	if (!isPermissionMode(legacyMode)) return policy;
	const base = policyForMode(legacyMode);
	return {
		filesystemRead: base.filesystemRead,
		filesystemWrite: base.filesystemWrite,
		terminal: base.terminal,
		reason: policy.reason,
		updatedAt: policy.updatedAt,
	};
}

/** Resolves persisted capability flags into the ACP client capability shell. */
export function resolvePermissionPolicy(
	policy?: GeminiAcpPermissionPolicy,
): ResolvedPermissionPolicy {
	const migrated = migrateLegacyPermissionPolicy(policy);
	if (!migrated) return DEFAULT_POLICY;
	const filesystemRead = migrated.filesystemRead === true;
	const filesystemWrite = migrated.filesystemWrite === true;
	const terminal = migrated.terminal === true;
	return {
		mode: modeForCapabilities(filesystemRead, filesystemWrite, terminal),
		filesystemRead,
		filesystemWrite,
		terminal,
		reason: migrated.reason,
		updatedAt: migrated.updatedAt,
	};
}

/** Normalizes individual capability settings before persisting them. */
export function normalizePermissionPolicy(
	capabilities: Pick<GeminiAcpPermissionPolicy, "filesystemRead" | "filesystemWrite" | "terminal">,
	reason?: string,
): GeminiAcpPermissionPolicy {
	return {
		filesystemRead: capabilities.filesystemRead === true,
		filesystemWrite: capabilities.filesystemWrite === true,
		terminal: capabilities.terminal === true,
		reason: reason?.trim() ?? undefined,
		updatedAt: new Date().toISOString(),
	};
}

export function describePermissionPolicy(policy?: GeminiAcpPermissionPolicy): string {
	const resolved = resolvePermissionPolicy(policy);
	const allowed = enabledPermissionLabels(resolved);
	return `${resolved.mode}: ${allowed.length > 0 ? allowed.join(", ") : "no filesystem or terminal access"}`;
}

export function permissionPolicyCapabilities(
	policy?: GeminiAcpPermissionPolicy,
): AcpClientCapabilities {
	const resolved = resolvePermissionPolicy(policy);
	return {
		auth: { terminal: false },
		fs: {
			readTextFile: resolved.filesystemRead,
			writeTextFile: resolved.filesystemWrite,
		},
		terminal: resolved.terminal,
	};
}

export function requirePermissionCapability(
	policy: GeminiAcpPermissionPolicy | undefined,
	capability: PermissionCapability,
): StructuredError | undefined {
	const resolved = resolvePermissionPolicy(policy);
	const allowed = capabilityEnabled(resolved, capability);
	if (allowed) return undefined;
	return {
		code: "GEMINI_ACP_PERMISSION_POLICY_DENIED",
		phase: "permission_policy",
		message: `The active Gemini ACP permission policy (${resolved.mode}) does not allow ${permissionLabel(capability)}. Run /gemini-config permissions to enable this capability if the action is intentional.`,
		retryable: false,
		provider: "gemini-acp",
	};
}

export function isPermissionMode(value: unknown): value is GeminiAcpPermissionMode {
	return (
		typeof value === "string" && (GEMINI_ACP_PERMISSION_MODES as readonly string[]).includes(value)
	);
}

function modeForCapabilities(
	filesystemRead: boolean,
	filesystemWrite: boolean,
	terminal: boolean,
): PermissionPolicyDisplayMode {
	if (!filesystemRead && !filesystemWrite && !terminal) return "restrictive";
	if (filesystemRead && !filesystemWrite && !terminal) return "file-read";
	if (filesystemRead && filesystemWrite && !terminal) return "file-read-write";
	if (!filesystemRead && !filesystemWrite && terminal) return "terminal";
	return "custom";
}

function policyForMode(mode: GeminiAcpPermissionMode): ResolvedPermissionPolicy {
	switch (mode) {
		case "file-read":
			return {
				mode,
				filesystemRead: true,
				filesystemWrite: false,
				terminal: false,
			};
		case "file-read-write":
			return {
				mode,
				filesystemRead: true,
				filesystemWrite: true,
				terminal: false,
			};
		case "terminal":
			return {
				mode,
				filesystemRead: false,
				filesystemWrite: false,
				terminal: true,
			};
		case "restrictive":
			return DEFAULT_POLICY;
	}
}

function enabledPermissionLabels(resolved: ResolvedPermissionPolicy): string[] {
	return [
		resolved.filesystemRead ? "filesystem read" : undefined,
		resolved.filesystemWrite ? "filesystem write" : undefined,
		resolved.terminal ? "terminal" : undefined,
		// oxlint-disable-next-line unicorn/prefer-native-coercion-functions -- type guard preserves string[] return type
	].filter((label): label is string => Boolean(label));
}

function capabilityEnabled(
	resolved: ResolvedPermissionPolicy,
	capability: PermissionCapability,
): boolean {
	switch (capability) {
		case "filesystemRead":
			return resolved.filesystemRead;
		case "filesystemWrite":
			return resolved.filesystemWrite;
		case "terminal":
			return resolved.terminal;
	}
}

function permissionLabel(capability: PermissionCapability): string {
	switch (capability) {
		case "filesystemRead":
			return "filesystem reads";
		case "filesystemWrite":
			return "filesystem writes";
		case "terminal":
			return "terminal execution";
	}
}
