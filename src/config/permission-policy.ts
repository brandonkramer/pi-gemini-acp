import type { GeminiAcpPermissionPolicy, StructuredError } from "../types.js";

export const GEMINI_ACP_PERMISSION_MODES = [
	"restrictive",
	"file-read",
	"file-read-write",
	"terminal",
] as const;

export type GeminiAcpPermissionMode =
	(typeof GEMINI_ACP_PERMISSION_MODES)[number];

export type PermissionCapability =
	| "filesystemRead"
	| "filesystemWrite"
	| "terminal";

export interface ResolvedPermissionPolicy {
	mode: GeminiAcpPermissionMode;
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

const DEFAULT_POLICY: ResolvedPermissionPolicy = {
	mode: "restrictive",
	filesystemRead: false,
	filesystemWrite: false,
	terminal: false,
};

export function resolvePermissionPolicy(
	policy?: GeminiAcpPermissionPolicy,
): ResolvedPermissionPolicy {
	const mode = isPermissionMode(policy?.mode) ? policy.mode : "restrictive";
	const base = policyForMode(mode);
	return {
		...base,
		reason: policy?.reason,
		updatedAt: policy?.updatedAt,
	};
}

export function normalizePermissionPolicy(
	mode: GeminiAcpPermissionMode,
	reason?: string,
): GeminiAcpPermissionPolicy {
	return {
		mode,
		reason: reason?.trim() || undefined,
		updatedAt: new Date().toISOString(),
	};
}

export function describePermissionPolicy(
	policy?: GeminiAcpPermissionPolicy,
): string {
	const resolved = resolvePermissionPolicy(policy);
	const allowed = [
		resolved.filesystemRead ? "filesystem read" : undefined,
		resolved.filesystemWrite ? "filesystem write" : undefined,
		resolved.terminal ? "terminal" : undefined,
	].filter(Boolean);
	return `${resolved.mode}: ${allowed.length ? allowed.join(", ") : "no filesystem or terminal access"}`;
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
	const allowed =
		capability === "filesystemRead"
			? resolved.filesystemRead
			: capability === "filesystemWrite"
				? resolved.filesystemWrite
				: resolved.terminal;
	if (allowed) return undefined;
	return {
		code: "GEMINI_ACP_PERMISSION_POLICY_DENIED",
		phase: "permission_policy",
		message: `The active Gemini ACP permission policy (${resolved.mode}) does not allow ${permissionLabel(capability)}. Run /gemini-set-permission-policy with an explicit broader mode if this action is intentional.`,
		retryable: false,
		provider: "gemini-acp",
	};
}

export function isPermissionMode(
	value: unknown,
): value is GeminiAcpPermissionMode {
	return (
		typeof value === "string" &&
		(GEMINI_ACP_PERMISSION_MODES as readonly string[]).includes(value)
	);
}

function policyForMode(
	mode: GeminiAcpPermissionMode,
): ResolvedPermissionPolicy {
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
