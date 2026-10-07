import { loadConfig, searchEnabledFromConfig, saveSearchEnabled } from "../config/settings.ts";
import type { StorageOptions } from "../storage/paths.ts";
import { toolResult } from "../tools/result.ts";
import type { InteractiveCommandContext } from "./picker.ts";

export interface GeminiConfigSearchParams {
	searchAction?: "enable" | "disable" | "status";
}

export interface GeminiConfigSearchResult {
	action: "enable" | "disable" | "status";
	searchEnabled: boolean;
	envDisabled: boolean;
}

export async function runGeminiConfigSearch(
	params: GeminiConfigSearchParams = {},
	options: StorageOptions = {},
) {
	const action = params.searchAction ?? "status";
	if (action === "enable" || action === "disable") {
		await saveSearchEnabled(action === "enable", options);
	}
	const result: GeminiConfigSearchResult = {
		action,
		searchEnabled: searchEnabledFromConfig(await loadConfig(options)),
		envDisabled: process.env.PI_GEMINI_ACP_SEARCH === "0",
	};
	return toolResult({
		text: [
			"Gemini search tool:",
			`- enabled: ${result.searchEnabled ? "yes" : "no"}`,
			result.envDisabled ? "- PI_GEMINI_ACP_SEARCH=0 overrides the saved setting." : undefined,
			"- Gemini tools are exposed only to Gemini models. Changes apply before the next model request.",
		]
			.filter(Boolean)
			.join("\n"),
		data: result,
	});
}

export async function showGeminiConfigSearchPicker(
	ctx: InteractiveCommandContext,
	options: StorageOptions = {},
) {
	const enabled = searchEnabledFromConfig(await loadConfig(options));
	const picked = await ctx.ui.select(
		`Search tool (gemini_search): ${enabled ? "enabled" : "disabled"}`,
		["Enable", "Disable", "Status"],
		{ signal: ctx.signal },
	);
	if (!picked) return toolResult({ text: "Cancelled.", data: { cancelled: true } });
	return await runGeminiConfigSearch(
		{ searchAction: picked === "Enable" ? "enable" : picked === "Disable" ? "disable" : "status" },
		options,
	);
}
