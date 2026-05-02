import { type Static, StringEnum, Type } from "@mariozechner/pi-ai";
import {
	describePermissionPolicy,
	GEMINI_ACP_PERMISSION_MODES,
	type GeminiAcpPermissionMode,
	normalizePermissionPolicy,
	resolvePermissionPolicy,
} from "../config/permission-policy.js";
import { saveGeminiAcpSettings } from "../config/settings.js";
import type { StorageOptions } from "../storage/paths.js";
import { errorResult, providerError, toolResult } from "../tools/result.js";
import type { GeminiAcpPermissionPolicy } from "../types.js";
import { defineGeminiCommand } from "./define.js";

export const geminiSetPermissionPolicySchema = Type.Object({
	mode: StringEnum(GEMINI_ACP_PERMISSION_MODES, {
		description:
			"Permission mode: restrictive keeps terminal and filesystem disabled; broader modes require confirmRisk.",
	}),
	confirmRisk: Type.Optional(
		Type.Boolean({
			description:
				"Must be true for any mode broader than restrictive/default.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description:
				"Optional human reason to store with the policy for later status output.",
		}),
	),
});

type Params = Static<typeof geminiSetPermissionPolicySchema>;

export interface SetPermissionPolicyResult {
	permissionPolicy: GeminiAcpPermissionPolicy;
	resolved: ReturnType<typeof resolvePermissionPolicy>;
	summary: string;
}

export async function setGeminiPermissionPolicy(
	params: Params,
	options: StorageOptions = {},
) {
	const mode = params.mode as GeminiAcpPermissionMode;
	if (mode !== "restrictive" && params.confirmRisk !== true) {
		return errorResult(
			providerError(
				"GEMINI_ACP_PERMISSION_CONFIRMATION_REQUIRED",
				"permission_policy",
				"Broader Gemini ACP permission policies require confirmRisk: true and should only be enabled for a specific advanced workflow.",
			),
		);
	}
	const permissionPolicy = normalizePermissionPolicy(mode, params.reason);
	const config = await saveGeminiAcpSettings({ permissionPolicy }, options);
	const stored = config.providers?.["gemini-acp"]?.permissionPolicy;
	const summary = describePermissionPolicy(stored);
	return toolResult<SetPermissionPolicyResult>({
		text: `Gemini ACP permission policy set to ${summary}.`,
		data: {
			permissionPolicy: stored ?? permissionPolicy,
			resolved: resolvePermissionPolicy(stored),
			summary,
		},
	});
}

export const geminiSetPermissionPolicyCommand = defineGeminiCommand({
	name: "gemini-set-permission-policy",
	description:
		"Persist the Gemini ACP permission policy. Defaults are restrictive; broader filesystem or terminal capabilities require explicit confirmation.",
	parameters: geminiSetPermissionPolicySchema,
	execute: (params) => setGeminiPermissionPolicy(params),
});
