import type {
	GeminiAcpPermissionPolicy,
	GeminiAcpProviderSettings,
	StructuredError,
} from "../types.ts";

export const GEMINI_ACP_PERMISSION_MODES = [
	"restrictive",
	"file-read",
	"file-read-write",
	"terminal",
] as const;

export type GeminiAcpPermissionMode = (typeof GEMINI_ACP_PERMISSION_MODES)[number];

export type PermissionPolicyDisplayMode = GeminiAcpPermissionMode | "full" | "custom";

/**
 * Which sessions a policy governs. "chat": Gemini selected as Pi's model, the user's own coding
 * agent. "tools": the gemini_* tools another model calls, typically on untrusted web pages or
 * files, so a prompt-injection path that needs no writes, commands or fetches.
 */
export type PermissionScope = "chat" | "tools";

/** Chat default when nothing is saved: everything allowed, like Pi's own tools. */
export const CHAT_DEFAULT_PERMISSION_POLICY: GeminiAcpPermissionPolicy = {
	filesystemRead: true,
	filesystemWrite: true,
	terminal: true,
	webFetch: true,
};

/** Where the effective chat policy comes from. */
export type ChatPolicyOrigin = "chat" | "provider" | "default";

/**
 * The policy for chat sessions: `chat.permissionPolicy`, else a policy saved before chat and tools
 * had separate policies (the user's earlier choice is kept), else the allow-all chat default.
 */
export function chatPermissionPolicy(settings: GeminiAcpProviderSettings | undefined): {
	policy: GeminiAcpPermissionPolicy;
	origin: ChatPolicyOrigin;
} {
	if (settings?.chat?.permissionPolicy) {
		return { policy: settings.chat.permissionPolicy, origin: "chat" };
	}
	if (settings?.permissionPolicy) return { policy: settings.permissionPolicy, origin: "provider" };
	return { policy: CHAT_DEFAULT_PERMISSION_POLICY, origin: "default" };
}

export type PermissionCapability = "filesystemRead" | "filesystemWrite" | "terminal" | "webFetch";

/** Every capability, in display order. */
export const PERMISSION_CAPABILITIES: readonly PermissionCapability[] = [
	"filesystemRead",
	"filesystemWrite",
	"terminal",
	"webFetch",
];

export interface ResolvedPermissionPolicy {
	mode: PermissionPolicyDisplayMode;
	filesystemRead: boolean;
	filesystemWrite: boolean;
	terminal: boolean;
	webFetch: boolean;
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
	webFetch: false,
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
		webFetch: policy.webFetch === true,
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
	const webFetch = migrated.webFetch === true;
	return {
		mode:
			filesystemRead && filesystemWrite && terminal && webFetch
				? "full"
				: webFetch
					? "custom"
					: modeForCapabilities(filesystemRead, filesystemWrite, terminal),
		filesystemRead,
		filesystemWrite,
		terminal,
		webFetch,
		reason: migrated.reason,
		updatedAt: migrated.updatedAt,
	};
}

/** Normalizes individual capability settings before persisting them. */
export function normalizePermissionPolicy(
	capabilities: Pick<
		GeminiAcpPermissionPolicy,
		"filesystemRead" | "filesystemWrite" | "terminal" | "webFetch"
	>,
	reason?: string,
): GeminiAcpPermissionPolicy {
	return {
		filesystemRead: capabilities.filesystemRead === true,
		filesystemWrite: capabilities.filesystemWrite === true,
		terminal: capabilities.terminal === true,
		webFetch: capabilities.webFetch === true,
		reason: reason?.trim() ?? undefined,
		updatedAt: new Date().toISOString(),
	};
}

export function describePermissionPolicy(policy?: GeminiAcpPermissionPolicy): string {
	const resolved = resolvePermissionPolicy(policy);
	const allowed = enabledPermissionLabels(resolved);
	return `${resolved.mode}: ${allowed.length > 0 ? allowed.join(", ") : "no filesystem, terminal or web fetch access"}`;
}

/** Session facts that affect which ACP client capabilities can be honored. */
export interface ClientCapabilityOptions {
	/** Pi has an allowlist of files for this session and will serve `fs/read_text_file` for them. */
	servesFileReads?: boolean;
}

/**
 * Advertises implemented ACP client services, not permission to use Gemini's own tools. Writes and
 * terminal execution currently run inside Gemini CLI. Its approval policy determines whether it
 * asks this client for permission; these flags are not a sandbox.
 *
 * `fs.readTextFile` is advertised only when the policy allows reads _and_ the session actually
 * serves them (a non-empty allowlist, e.g. `gemini_analyze`). Gemini CLI sends every read inside
 * the session root to the client once the capability is advertised, so advertising it for sessions
 * without an allowlist (chat, search) would make every project file read fail. Without the
 * capability Gemini CLI reads files itself.
 */
export function permissionPolicyCapabilities(
	policy?: GeminiAcpPermissionPolicy,
	options: ClientCapabilityOptions = {},
): AcpClientCapabilities {
	const resolved = resolvePermissionPolicy(policy);
	return {
		auth: { terminal: false },
		fs: {
			readTextFile: resolved.filesystemRead && options.servesFileReads === true,
			writeTextFile: false,
		},
		terminal: false,
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
				webFetch: false,
			};
		case "file-read-write":
			return {
				mode,
				filesystemRead: true,
				filesystemWrite: true,
				terminal: false,
				webFetch: false,
			};
		case "terminal":
			return {
				mode,
				filesystemRead: false,
				filesystemWrite: false,
				terminal: true,
				webFetch: false,
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
		resolved.webFetch ? "web fetch" : undefined,
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
		case "webFetch":
			return resolved.webFetch;
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
		case "webFetch":
			return "web fetches";
	}
}
