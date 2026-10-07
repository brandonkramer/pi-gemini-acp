import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfigSync, searchEnabledFromConfig } from "../config/settings.ts";
import type { StorageOptions } from "../storage/paths.ts";
import { geminiAcpTools } from "./register.ts";

/** Match Gemini through ACP, Google, or another provider such as OpenRouter. */
export function isGeminiModel(model: { id: string; provider: string } | undefined): boolean {
	return Boolean(
		model &&
		(model.provider === "gemini-acp" || /(?:^|[/.:_-])gemini(?:$|[/.:_-])/iu.test(model.id)),
	);
}

/** Hide only this extension's tools, remembering which ones we removed. */
export function registerGeminiToolModelScope(
	pi: Pick<ExtensionAPI, "on" | "getActiveTools" | "setActiveTools">,
	options: StorageOptions = {},
): void {
	const names = new Set<string>(geminiAcpTools.map((tool) => tool.name));
	const hidden = new Set<string>();
	const update = (model: { id: string; provider: string } | undefined) => {
		const active = pi.getActiveTools();
		const gemini = isGeminiModel(model);
		const searchEnabled = searchEnabledFromConfig(loadConfigSync(options));
		const allowed = (name: string) => gemini && (name !== "gemini_search" || searchEnabled);
		const next = active.filter((name) => {
			if (!names.has(name) || allowed(name)) return true;
			hidden.add(name);
			return false;
		});
		for (const name of hidden) {
			if (allowed(name)) {
				if (!next.includes(name)) next.push(name);
				hidden.delete(name);
			}
		}
		if (next.length !== active.length || next.some((name, i) => name !== active[i])) {
			pi.setActiveTools(next);
		}
	};
	pi.on("session_start", (_event, ctx) => update(ctx.model));
	pi.on("model_select", (event) => update(event.model));
	// Also pick up config changes before the next model request.
	pi.on("before_agent_start", (_event, ctx) => update(ctx.model));
}
