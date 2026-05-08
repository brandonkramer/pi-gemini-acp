import { type Static, Type } from "@earendil-works/pi-ai";
import { getGeminiAcpStatus } from "../config/status.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiTool, type ToolRenderResultOptions } from "./define.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	renderGeminiToolCallTitle,
} from "./gemini-rendering.js";
import { toolResult } from "./result.js";

export const geminiAcpStatusSchema = Type.Object({});

type Params = Static<typeof geminiAcpStatusSchema>;

export const geminiAcpStatusTool = defineGeminiTool({
	name: "gemini_status",
	label: "Gemini ACP Status",
	description: "ACP status/caps;localDocs no ACP",
	parameters: geminiAcpStatusSchema,
	async execute(_toolCallId, _params: Params) {
		const status = await getGeminiAcpStatus();
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
		return boxedToolText(
			dimToolText(formatStatusToolDisplay(result, options), theme),
		);
	},
});

type GeminiStatusData = Awaited<ReturnType<typeof getGeminiAcpStatus>>;

function formatStatusToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
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
		expandedToolOutputHint("full Gemini ACP status"),
	].join("\n");
}

function isGeminiStatusData(value: unknown): value is GeminiStatusData {
	return (
		typeof value === "object" &&
		value !== null &&
		"ready" in value &&
		"capabilities" in value &&
		"command" in value
	);
}

function statusText(status: GeminiStatusData): string {
	const headline = status.ready
		? "Gemini ACP is ready for Gemini-backed search/research."
		: `Gemini ACP needs attention: ${status.error?.message ?? status.state}.`;
	const fileAnalysis = status.capabilities.fileAnalysisAvailable;
	return [
		headline,
		`File analysis capability: ${boolLabel(fileAnalysis, "available", "not confirmed")}; gemini_analyze uses ACP resource links for validated files when filesystem-read permission is enabled.`,
		`Image input: ${boolLabel(status.capabilities.imageInput.available, "available", "not confirmed")} (${status.capabilities.imageInput.transport}; gemini_analyze uses validated image resource links when available).`,
		...status.remediation.map((item) => `- ${item}`),
	].join("\n");
}

function boolLabel(
	value: boolean | "unknown",
	trueLabel: string,
	falseLabel: string,
): string {
	if (value === "unknown") return "unknown";
	return value ? trueLabel : falseLabel;
}
