/** @file Public gemini_status tool and runtime status rendering. */
import { type Static, Type } from "@earendil-works/pi-ai";

import { getAccountPoolStatus } from "../acp/account-pool-singleton.ts";
import { getModelAdapterStatus } from "../adapter/status.ts";
import { geminiApiKeyConfigured } from "../api/config.ts";
import { getQuotaExhaustedEntries } from "../api/quota-cache.ts";
import { configFromEnv, loadConfig } from "../config/settings.ts";
import { getGeminiAcpStatus } from "../config/status.ts";
import { getGeminiSearchPrewarmStatus, type GeminiSearchPrewarmStatus } from "../search/prewarm.ts";
import type { PiToolShell, ResultEnvelope } from "../types.ts";
import { defineGeminiTool, type ToolRenderResultOptions } from "./define.ts";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	renderGeminiToolCallTitle,
} from "./gemini-rendering.ts";
import { toolResult } from "./result.ts";

export const geminiAcpStatusSchema = Type.Object({});

type Params = Static<typeof geminiAcpStatusSchema>;

export const geminiAcpStatusTool = defineGeminiTool({
	name: "gemini_status",
	label: "Gemini ACP Status",
	description: "ACP status/caps;localDocs no ACP",
	parameters: geminiAcpStatusSchema,
	async execute(_toolCallId, _params: Params) {
		const loadedConfig = configFromEnv(await loadConfig());
		const providerStatus = await getGeminiAcpStatus({ config: loadedConfig });
		const quotaEntries = getQuotaExhaustedEntries();
		const poolStatus = getAccountPoolStatus(loadedConfig);
		const status: GeminiStatusData = {
			...providerStatus,
			runtime: { searchPrewarm: getGeminiSearchPrewarmStatus() },
			apiKeyFallback: geminiApiKeyConfigured(loadedConfig),
			quotaExhausted: quotaEntries.map((e) => ({
				model: e.model ?? "unknown",
				elapsedMinutes: Math.round((Date.now() - e.exhaustedAt) / 60000),
				resetAfterMinutes: e.resetAfterMs ? Math.round(e.resetAfterMs / 60000) : undefined,
			})),
			modelAdapter: getModelAdapterStatus(),
			accountPool: poolStatus
				? {
						totalAccounts: poolStatus.totalAccounts,
						activeAccounts: poolStatus.activeAccounts,
						cooledDown: poolStatus.cooldowns.map((c) => ({
							name: c.accountName,
							remainingMinutes: Math.max(0, Math.round((c.coolUntil - Date.now()) / 60000)),
							reason: c.reason,
						})),
					}
				: undefined,
		};
		return toolResult({
			text: statusText(status),
			data: status,
			status: status.ready ? "ok" : "needs_attention",
		});
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_status",
			stateKey: "geminiStatusTitle",
		});
	},
	renderResult(result, options, theme) {
		return boxedToolText(dimToolText(formatStatusToolDisplay(result, options), theme));
	},
});

type GeminiStatusData = Awaited<ReturnType<typeof getGeminiAcpStatus>> & {
	runtime: { searchPrewarm: GeminiSearchPrewarmStatus };
	apiKeyFallback: boolean;
	quotaExhausted: Array<{
		model: string;
		elapsedMinutes: number;
		resetAfterMinutes?: number;
	}>;
	modelAdapter: ReturnType<typeof getModelAdapterStatus>;
	accountPool?: {
		totalAccounts: number;
		activeAccounts: string[];
		cooledDown: Array<{
			name: string;
			remainingMinutes: number;
			reason: string;
		}>;
	};
};

function formatStatusToolDisplay(result: PiToolShell, options: ToolRenderResultOptions): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isGeminiStatusData(details.data)) {
		return formatCollapsedOrExpanded(details.data, options, {
			collapsed: formatStatusCollapsed,
			expanded: statusText,
		});
	}
	return result.content[0]?.text ?? "gemini_status";
}

function formatStatusCollapsed(status: GeminiStatusData): string {
	const headline = status.ready
		? "Gemini ACP ready"
		: `Gemini ACP needs attention: ${status.error?.code ?? status.state}`;
	return [
		headline,
		`auth: ${boolLabel(status.capabilities.authenticated, "confirmed", "not confirmed")}; search: ${boolLabel(status.capabilities.searchGroundingAvailable, "available", "not confirmed")}`,
		`file analysis: ${boolLabel(status.capabilities.fileAnalysisAvailable, "available", "not confirmed")}; image: ${boolLabel(status.capabilities.imageInput.available, "available", "not confirmed")}`,
		`prewarm: ${prewarmLabel(status.runtime.searchPrewarm)}`,
		`model adapter: ${status.modelAdapter.offered ? `offered (${status.modelAdapter.capabilities.join(", ")})` : "not offered"}`,
		expandedToolOutputHint("full Gemini ACP status"),
	].join("\n");
}

function isGeminiStatusData(value: unknown): value is GeminiStatusData {
	return (
		typeof value === "object" &&
		value !== null &&
		"ready" in value &&
		"capabilities" in value &&
		"command" in value &&
		"runtime" in value &&
		"apiKeyFallback" in value &&
		"quotaExhausted" in value &&
		"modelAdapter" in value
	);
}

function formatQuotaLines(entries: GeminiStatusData["quotaExhausted"]): string[] {
	if (entries.length === 0) return [];
	return entries.map((e) => {
		const reset = e.resetAfterMinutes ? `; reset in ~${e.resetAfterMinutes}m` : "";
		return `- Quota exhausted for ${e.model} (${e.elapsedMinutes}m ago${reset}). Using API key fallback.`;
	});
}

function statusText(status: GeminiStatusData): string {
	const headline = status.ready
		? "Gemini ACP is ready for Gemini-backed search/research."
		: `Gemini ACP needs attention: ${status.error?.message ?? status.state}.`;
	const fileAnalysis = status.capabilities.fileAnalysisAvailable;
	const adapter = status.modelAdapter;
	return [
		headline,
		`Search prewarm: ${prewarmLabel(status.runtime.searchPrewarm)}.`,
		`File analysis capability: ${boolLabel(fileAnalysis, "available", "not confirmed")}; gemini_analyze uses ACP resource links for validated files when filesystem-read permission is enabled.`,
		`Image input: ${boolLabel(status.capabilities.imageInput.available, "available", "not confirmed")} (${status.capabilities.imageInput.transport}; gemini_analyze uses validated image resource links when available).`,
		`Model adapter: ${adapter.offered ? `offered to pi-scraper (${adapter.capabilities.join(", ")}, priority ${adapter.priority})` : "not offered (set PI_GEMINI_ACP_OFFER_MODEL_ADAPTER=1 to enable)"}.`,
		status.apiKeyFallback
			? "Gemini API key fallback is configured (used when ACP is unavailable or quota exhausted)."
			: "Gemini API key fallback is not configured (set GEMINI_API_KEY for fallback).",
		...formatQuotaLines(status.quotaExhausted),
		...(status.accountPool
			? [
					`Account pool: ${status.accountPool.activeAccounts.length}/${status.accountPool.totalAccounts} active.`,
					...status.accountPool.cooledDown.map(
						(entry) =>
							`- ${entry.name}: cooled down (~${entry.remainingMinutes}m remaining). Reason: ${entry.reason.slice(0, 120)}`,
					),
				]
			: []),
		...status.remediation.map((item) => `- ${item}`),
	].join("\n");
}

function prewarmLabel(status: GeminiSearchPrewarmStatus): string {
	if (status.state === "warmed") return "last prewarm warmed ACP process and search session";
	if (status.state === "running") return "warming ACP process and search session";
	if (status.state === "not_started") return "not attempted in this process";
	if (status.state === "disabled") return "disabled by PI_GEMINI_ACP_NO_PREWARM";
	if (status.state === "failed") return "failed during warmup";
	if (status.skippedReason === "preflight") return "skipped: command, auth, or grounding not ready";
	if (status.skippedReason === "aborted") return "skipped: request aborted";
	return status.state;
}

function boolLabel(value: boolean | "unknown", trueLabel: string, falseLabel: string): string {
	if (value === "unknown") return "unknown";
	return value ? trueLabel : falseLabel;
}
