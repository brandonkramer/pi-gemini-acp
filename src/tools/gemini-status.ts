import { type Static, Type } from "@mariozechner/pi-ai";
import { getGeminiAcpStatus } from "../config/status.js";
import { defineGeminiTool } from "./define.js";
import { toolResult } from "./result.js";

export const geminiAcpStatusSchema = Type.Object({});

type Params = Static<typeof geminiAcpStatusSchema>;

export const geminiAcpStatusTool = defineGeminiTool({
	name: "gemini_status",
	label: "Gemini ACP Status",
	description:
		"Report read-only Gemini ACP command/auth/capability status from explicit persisted/env settings. Local supplied-document workflows do not require Gemini ACP; provider-backed search may still use the legacy default `gemini --acp` shim until explicit settings are configured.",
	parameters: geminiAcpStatusSchema,
	async execute(_toolCallId, _params: Params) {
		const status = await getGeminiAcpStatus();
		return toolResult({
			text: statusText(status),
			data: status,
			status: status.ready ? "ok" : "needs_attention",
		});
	},
});

function statusText(
	status: Awaited<ReturnType<typeof getGeminiAcpStatus>>,
): string {
	const headline = status.ready
		? "Gemini ACP is ready for Gemini-backed search/research."
		: `Gemini ACP needs attention: ${status.error?.message ?? status.state}.`;
	return `${headline}\n${status.remediation.map((item) => `- ${item}`).join("\n")}`;
}
