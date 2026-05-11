import {
	describePermissionPolicy,
	normalizePermissionPolicy,
	type PermissionCapability,
	type ResolvedPermissionPolicy,
	resolvePermissionPolicy,
} from "../config/permission-policy.ts";
import { loadConfig, saveGeminiAcpSettings } from "../config/settings.ts";
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

export interface GeminiConfigPermissionsResult {
	permissionPolicy: GeminiAcpPermissionPolicy;
	resolved: ResolvedPermissionPolicy;
	summary: string;
	capabilities: PermissionCapabilitySetting[];
}

/** Shows or updates Gemini ACP capability settings for `/gemini-config permissions`. */
export async function runGeminiConfigPermissions(
	toggle: PermissionToggleInput = {},
	options: GeminiConfigPermissionsOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigPermissionsResult | null>>> {
	const currentPolicy = await loadCurrentPermissionPolicy(options);
	const currentResolved = resolvePermissionPolicy(currentPolicy);

	if (!toggle.capability) {
		return permissionsDisplayResult(currentPolicy);
	}

	const nextEnabled = toggle.enabled ?? !capabilityEnabled(currentResolved, toggle.capability);
	if (requiresConfirmation(toggle.capability, nextEnabled, toggle.confirmRisk)) {
		return errorResult(
			providerError(
				"GEMINI_ACP_PERMISSION_CONFIRMATION_REQUIRED",
				"permission_policy",
				"Enabling filesystem write or terminal execution requires confirmRisk: true. These capabilities allow the ACP to modify files or run shell commands.",
			),
		);
	}

	const permissionPolicy = normalizePermissionPolicy(
		{
			filesystemRead: currentResolved.filesystemRead,
			filesystemWrite: currentResolved.filesystemWrite,
			terminal: currentResolved.terminal,
			[toggle.capability]: nextEnabled,
		},
		toggle.reason ?? currentResolved.reason,
	);
	const config = await saveGeminiAcpSettings(permissionPolicySettings(permissionPolicy), {
		rootDir: options.rootDir,
	});
	const stored = config.providers?.["gemini-acp"]?.permissionPolicy;
	return permissionsDisplayResult(stored ?? permissionPolicy, "updated");
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
	while (true) {
		const result = await runGeminiConfigPermissions({}, options);
		const data = (result.details as ResultEnvelope<GeminiConfigPermissionsResult>).data;
		if (!data) return result;

		const choices = permissionsChoices(data.capabilities);
		const picked = await ctx.ui.select("Gemini ACP permissions", choices, {
			signal: ctx.signal,
		});
		if (!picked || picked === "Done") {
			return toolResult({ text: data.summary, data });
		}

		const setting = data.capabilities[choices.indexOf(picked)];
		if (!setting) continue;
		const enabled = !setting.enabled;
		const confirmRisk = await confirmPermissionRisk(ctx, setting, enabled);
		if (confirmRisk === undefined) continue;
		const toggleResult = await runGeminiConfigPermissions(
			{ capability: setting.capability, enabled, confirmRisk },
			options,
		);
		if ((toggleResult.details as ResultEnvelope).error) {
			notifyResult(ctx, toggleResult);
		}
	}
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
		`${setting.description}\n\nThis allows ACP to ${setting.requiredFor}.`,
		{ signal: ctx.signal },
	);
	return confirmed ? true : undefined;
}

async function loadCurrentPermissionPolicy(
	options: GeminiConfigPermissionsOptions,
): Promise<GeminiAcpPermissionPolicy | undefined> {
	const config = options.config ?? (await loadConfig({ rootDir: options.rootDir }));
	return config.providers?.["gemini-acp"]?.permissionPolicy;
}

function permissionPolicySettings(permissionPolicy: GeminiAcpPermissionPolicy) {
	return { permissionPolicy };
}

function permissionsDisplayResult(
	policy?: GeminiAcpPermissionPolicy,
	status: "ok" | "updated" = "ok",
): PiToolShell<ResultEnvelope<GeminiConfigPermissionsResult>> {
	const result = permissionsResult(policy);
	return toolResult({
		text: formatPermissionsDisplay(result),
		data: result,
		status,
	});
}

function permissionsResult(policy?: GeminiAcpPermissionPolicy): GeminiConfigPermissionsResult {
	const resolved = resolvePermissionPolicy(policy);
	return {
		permissionPolicy: policy ?? {},
		resolved,
		summary: describePermissionPolicy(policy),
		capabilities: capabilitySettings(resolved),
	};
}

function formatPermissionsDisplay(result: GeminiConfigPermissionsResult): string {
	return [
		"Gemini ACP Capabilities:",
		...result.capabilities.map(formatCapabilityLine),
		`Current: ${formatCurrentSummary(result.resolved)}`,
	].join("\n");
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
	].filter(Boolean);
	if (allowed.length === 0) return "restrictive (no capabilities enabled)";
	return `${resolved.mode} (${allowed.join(", ")})`;
}

function capabilitySettings(resolved: ResolvedPermissionPolicy): PermissionCapabilitySetting[] {
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
			requiresConfirmation: true,
		},
		{
			capability: "terminal",
			label: "Terminal execution",
			description: "Allow Gemini ACP to execute shell commands.",
			requiredFor: "build commands, tests, package installation",
			enabled: resolved.terminal,
			requiresConfirmation: true,
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
	}
}

function requiresConfirmation(
	capability: PermissionCapability,
	enabled: boolean,
	confirmRisk: boolean | undefined,
): boolean {
	return (
		enabled &&
		confirmRisk !== true &&
		(capability === "filesystemWrite" || capability === "terminal")
	);
}
