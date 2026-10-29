import {
	type ChatPolicyOrigin,
	chatPermissionPolicy,
	describePermissionPolicy,
	normalizePermissionPolicy,
	type PermissionCapability,
	type PermissionScope,
	type ResolvedPermissionPolicy,
	resolvePermissionPolicy,
} from "../config/permission-policy.ts";
import { loadConfig, saveChatSettings, saveGeminiAcpSettings } from "../config/settings.ts";
import { providerError } from "../prompt/provider-result.ts";
import type { StorageOptions } from "../storage/paths.ts";
import { errorResult, toolResult } from "../tools/result.ts";
import type {
	GeminiAcpConfig,
	GeminiAcpPermissionPolicy,
	PiToolShell,
	ResultEnvelope,
} from "../types.ts";
import type { PiCommandContext } from "./define.ts";
import { hasInteractiveUi, type InteractiveCommandContext, notifyResult } from "./picker.ts";

export interface PermissionToggle {
	/** Policy to change; defaults to "tools", the meaning of the command before the split. */
	scope?: PermissionScope;
	capability: PermissionCapability;
	enabled: boolean;
	confirmRisk?: boolean;
	reason?: string;
}

type PermissionToggleInput = Partial<PermissionToggle>;

export interface GeminiConfigPermissionsOptions extends StorageOptions {
	config?: GeminiAcpConfig;
}

export interface PermissionCapabilitySetting {
	capability: PermissionCapability;
	label: string;
	description: string;
	requiredFor: string;
	enabled: boolean;
	requiresConfirmation: boolean;
}

/** One of the two policies, as shown by `/gemini-config permissions`. */
export interface ScopePermissions {
	scope: PermissionScope;
	/** For chat: saved chat policy, policy kept from before the split, or the default. */
	origin: ChatPolicyOrigin;
	permissionPolicy: GeminiAcpPermissionPolicy;
	resolved: ResolvedPermissionPolicy;
	summary: string;
	capabilities: PermissionCapabilitySetting[];
}

export interface GeminiConfigPermissionsResult {
	chat: ScopePermissions;
	tools: ScopePermissions;
}

const SCOPE_TITLES: Record<PermissionScope, string> = {
	chat: "Chat model (Gemini selected as Pi's model)",
	tools: "Gemini tools (gemini_search, gemini_research, gemini_ask, gemini_analyze)",
};

/** Shows or updates the Gemini ACP permission policies for `/gemini-config permissions`. */
export async function runGeminiConfigPermissions(
	toggle: PermissionToggleInput = {},
	options: GeminiConfigPermissionsOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigPermissionsResult | null>>> {
	const config = options.config ?? (await loadConfig({ rootDir: options.rootDir }));

	if (!toggle.capability) {
		return permissionsDisplayResult(config, toggle.scope);
	}

	const scope = toggle.scope ?? "tools";
	const current = permissionsResult(config)[scope].resolved;
	const nextEnabled = toggle.enabled ?? !capabilityEnabled(current, toggle.capability);
	if (requiresConfirmation(scope, toggle.capability, nextEnabled, toggle.confirmRisk)) {
		return errorResult(
			providerError(
				"GEMINI_ACP_PERMISSION_CONFIRMATION_REQUIRED",
				"permission_policy",
				"Enabling filesystem write, terminal execution or web fetch for the gemini_* tools requires confirmRisk: true. These tools usually process untrusted web pages or files, which can contain prompt injection; these capabilities would let it modify files, run shell commands or send data to URLs.",
			),
		);
	}

	const permissionPolicy = normalizePermissionPolicy(
		{
			filesystemRead: current.filesystemRead,
			filesystemWrite: current.filesystemWrite,
			terminal: current.terminal,
			webFetch: current.webFetch,
			[toggle.capability]: nextEnabled,
		},
		toggle.reason ?? current.reason,
	);
	const saved = await savePolicy(scope, permissionPolicy, options);
	return permissionsDisplayResult(saved, scope, "updated");
}

/**
 * Saves one policy. The chat policy falls back to the provider-level (tools) policy when it has
 * none of its own, so before the tools policy changes, the chat policy in effect is saved to the
 * chat settings: changing one scope never changes the other.
 */
async function savePolicy(
	scope: PermissionScope,
	permissionPolicy: GeminiAcpPermissionPolicy,
	options: StorageOptions,
): Promise<GeminiAcpConfig> {
	// Start from the saved file, never from a config merged with environment overrides.
	const storage = { rootDir: options.rootDir };
	const config = await loadConfig(storage);
	const provider = config.providers?.["gemini-acp"];
	const chat = provider?.chat ?? {};
	if (scope === "chat") {
		return await saveChatSettings({ ...chat, permissionPolicy }, storage, config);
	}
	if (!chat.permissionPolicy) {
		await saveChatSettings(
			{ ...chat, permissionPolicy: chatPermissionPolicy(provider).policy },
			storage,
			config,
		);
	}
	// Reloads the file, so it includes the chat settings saved above.
	return await saveGeminiAcpSettings({ permissionPolicy }, storage);
}

export async function showGeminiConfigPermissionsPicker(
	ctx: PiCommandContext,
	options: GeminiConfigPermissionsOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigPermissionsResult | null>>> {
	if (!hasInteractiveUi(ctx)) return await runGeminiConfigPermissions({}, options);
	return await showInteractivePermissionsPicker(ctx, options);
}

async function showInteractivePermissionsPicker(
	ctx: InteractiveCommandContext,
	options: GeminiConfigPermissionsOptions,
): Promise<PiToolShell<ResultEnvelope<GeminiConfigPermissionsResult | null>>> {
	for (;;) {
		const overview = await runGeminiConfigPermissions({}, { rootDir: options.rootDir });
		const data = overview.details.data;
		if (!data) return overview;
		const scopeChoices = [scopeChoice(data.chat), scopeChoice(data.tools), "Done"];
		const pickedScope = await ctx.ui.select("Gemini ACP permissions", scopeChoices, {
			signal: ctx.signal,
		});
		if (!pickedScope || pickedScope === "Done") return overview;
		const scope: PermissionScope = pickedScope === scopeChoices[0] ? "chat" : "tools";
		await showScopePicker(ctx, scope, options);
	}
}

async function showScopePicker(
	ctx: InteractiveCommandContext,
	scope: PermissionScope,
	options: GeminiConfigPermissionsOptions,
): Promise<void> {
	for (;;) {
		const result = await runGeminiConfigPermissions({ scope }, { rootDir: options.rootDir });
		const data = result.details.data;
		if (!data) return;
		const settings = data[scope].capabilities;
		const choices = permissionsChoices(settings);
		const picked = await ctx.ui.select(SCOPE_TITLES[scope], choices, { signal: ctx.signal });
		if (!picked || picked === "Done") return;

		const settingIndex = choices.indexOf(picked);
		if (settingIndex < 0) continue;
		const setting = settings[settingIndex];
		const enabled = !setting.enabled;
		const confirmRisk = await confirmPermissionRisk(ctx, setting, enabled);
		if (confirmRisk === undefined) continue;
		const toggleResult = await runGeminiConfigPermissions(
			{ scope, capability: setting.capability, enabled, confirmRisk },
			{ rootDir: options.rootDir },
		);
		if ((toggleResult.details as ResultEnvelope).error) {
			notifyResult(ctx, toggleResult);
		}
	}
}

function scopeChoice(permissions: ScopePermissions): string {
	return `${SCOPE_TITLES[permissions.scope]}: ${formatCurrentSummary(permissions.resolved)}`;
}

function permissionsChoices(settings: PermissionCapabilitySetting[]): string[] {
	return [
		...settings.map((setting) => {
			const mark = setting.enabled ? "[x]" : "[ ]";
			const warning = setting.requiresConfirmation ? " (⚠️ requires confirmation)" : "";
			return `${mark} ${setting.label}${warning}`;
		}),
		"Done",
	];
}

async function confirmPermissionRisk(
	ctx: InteractiveCommandContext,
	setting: PermissionCapabilitySetting,
	enabled: boolean,
): Promise<boolean | undefined> {
	if (!enabled || !setting.requiresConfirmation) return false;
	const confirmed = await ctx.ui.confirm(
		`Enable ${setting.label}?`,
		`${setting.description}\n\nThis allows ACP to ${setting.requiredFor}.\n\nThe gemini_* tools usually process untrusted web pages or files, which can contain prompt injection.`,
		{ signal: ctx.signal },
	);
	return confirmed ? true : undefined;
}

function permissionsDisplayResult(
	config: GeminiAcpConfig,
	scope?: PermissionScope,
	status: "ok" | "updated" = "ok",
): PiToolShell<ResultEnvelope<GeminiConfigPermissionsResult>> {
	const result = permissionsResult(config);
	const scopes: PermissionScope[] = scope ? [scope] : ["chat", "tools"];
	return toolResult({
		text: scopes.map((name) => formatScope(result[name])).join("\n\n"),
		data: result,
		status,
	});
}

function permissionsResult(config: GeminiAcpConfig): GeminiConfigPermissionsResult {
	const provider = config.providers?.["gemini-acp"];
	const chat = chatPermissionPolicy(provider);
	return {
		chat: scopePermissions("chat", chat.policy, chat.origin),
		tools: scopePermissions("tools", provider?.permissionPolicy ?? {}, "provider"),
	};
}

function scopePermissions(
	scope: PermissionScope,
	policy: GeminiAcpPermissionPolicy,
	origin: ChatPolicyOrigin,
): ScopePermissions {
	const resolved = resolvePermissionPolicy(policy);
	return {
		scope,
		origin,
		permissionPolicy: policy,
		resolved,
		summary: describePermissionPolicy(policy),
		capabilities: capabilitySettings(scope, resolved),
	};
}

function formatScope(permissions: ScopePermissions): string {
	return [
		`${SCOPE_TITLES[permissions.scope]}:`,
		...permissions.capabilities.map(formatCapabilityLine),
		`Current: ${formatCurrentSummary(permissions.resolved)}${originNote(permissions)}`,
		`Change with: /gemini-config permissions ${permissions.scope} <capability> on|off`,
	].join("\n");
}

function originNote(permissions: ScopePermissions): string {
	if (permissions.scope === "tools") return "";
	switch (permissions.origin) {
		case "default":
			return " — default: everything allowed, as in Pi. This is not a sandbox; run Pi in a container for isolation.";
		case "provider":
			return " — kept from the policy saved before chat and tools had separate policies.";
		case "chat":
			return "";
	}
}

function formatCapabilityLine(setting: PermissionCapabilitySetting): string {
	const mark = setting.enabled ? "x" : " ";
	const warning = setting.requiresConfirmation ? " ⚠️ Requires confirmation." : "";
	return [
		`- [${mark}] ${setting.label} — ${setting.description}${warning}`,
		`  Required for: ${setting.requiredFor}.`,
	].join("\n");
}

function formatCurrentSummary(resolved: ResolvedPermissionPolicy): string {
	const allowed = [
		resolved.filesystemRead ? "filesystem read" : undefined,
		resolved.filesystemWrite ? "filesystem write" : undefined,
		resolved.terminal ? "terminal" : undefined,
		resolved.webFetch ? "web fetch" : undefined,
	].filter(Boolean);
	if (allowed.length === 0) return "restrictive (no capabilities enabled)";
	return `${resolved.mode} (${allowed.join(", ")})`;
}

function capabilitySettings(
	scope: PermissionScope,
	resolved: ResolvedPermissionPolicy,
): PermissionCapabilitySetting[] {
	// Only the tools scope asks for confirmation: there the risk is prompt injection the user never
	// sees. In chat, Gemini is the user's own agent, and Pi itself does not ask before tool calls.
	const confirm = scope === "tools";
	return [
		{
			capability: "filesystemRead",
			label: "Filesystem read",
			description: "Allow Gemini ACP to read text files from your workspace.",
			requiredFor: "file analysis, reading project docs",
			enabled: resolved.filesystemRead,
			requiresConfirmation: false,
		},
		{
			capability: "filesystemWrite",
			label: "Filesystem write",
			description: "Allow Gemini ACP to write text files to your workspace.",
			requiredFor: "code generation, file modifications",
			enabled: resolved.filesystemWrite,
			requiresConfirmation: confirm,
		},
		{
			capability: "terminal",
			label: "Terminal execution",
			description: "Allow Gemini ACP to execute shell commands.",
			requiredFor: "build commands, tests, package installation",
			enabled: resolved.terminal,
			requiresConfirmation: confirm,
		},
		{
			capability: "webFetch",
			label: "Web fetch",
			description:
				"Allow Gemini ACP to retrieve URLs it chooses with its web_fetch tool. A fetched URL can carry data out, and fetched pages can contain prompt injection.",
			requiredFor: "reading web pages and documentation beyond search results",
			enabled: resolved.webFetch,
			requiresConfirmation: confirm,
		},
	];
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

function requiresConfirmation(
	scope: PermissionScope,
	capability: PermissionCapability,
	enabled: boolean,
	confirmRisk: boolean | undefined,
): boolean {
	return (
		scope === "tools" &&
		enabled &&
		confirmRisk !== true &&
		(capability === "filesystemWrite" || capability === "terminal" || capability === "webFetch")
	);
}
