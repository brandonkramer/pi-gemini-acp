/**
 * @fileoverview Internal image-analysis route used by the gemini_analyze umbrella tool.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import {
	type ImageDescribeResult,
	runImageDescribe,
} from "../prompt/image-describe.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import type { PiToolShell } from "../types.js";
import type { ToolRenderResultOptions, ToolUpdate } from "../tools/define.js";
import {
	appendExpansionHint,
	renderPromptToolResult,
	resultMetadataLines,
} from "../tools/gemini-prompt-rendering.js";
import { truncateToolText } from "../tools/gemini-rendering.js";
import { errorResult, toolResult } from "../tools/result.js";

const imageModeSchema = Type.Union([
	Type.Literal("caption"),
	Type.Literal("objects"),
	Type.Literal("ocr"),
	Type.Literal("detailed"),
]);

const analyzeImageParamsSchema = Type.Object({
	imagePath: Type.Optional(
		Type.String({
			description: "Local PNG/JPEG/WebP/GIF path; symlinks refused.",
		}),
	),
	imageDataBase64: Type.Optional(
		Type.String({
			description: "Base64 bytes, validated only and not sent; use imagePath.",
		}),
	),
	mimeType: Type.Optional(
		Type.String({
			description: "Required for base64: image/png, jpeg, webp, or gif.",
		}),
	),
	mode: Type.Optional(imageModeSchema),
	instructions: Type.Optional(
		Type.String({ description: "Optional image analysis instructions." }),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Base dir for resolving imagePath; no scanning.",
		}),
	),
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response cache." }),
	),
});

type Params = Static<typeof analyzeImageParamsSchema>;

export const analyzeImageRoute = {
	async execute(
		_toolCallId: string,
		params: Params,
		signal: AbortSignal,
		onUpdate?: ToolUpdate,
		_ctx?: unknown,
	) {
		const result = await runImageDescribe(
			params,
			signal,
			imageDescribeToolUpdate(onUpdate),
		);
		if (result.error) {
			return errorResult(result.error, resultText(result), { data: result });
		}
		return toolResult({
			text: resultText(result),
			data: result,
			responseId: result.responseId,
			fullOutputPath: result.fullOutputPath,
		});
	},
	renderResult(
		result: PiToolShell,
		options: ToolRenderResultOptions,
		theme: unknown,
		_context?: unknown,
	) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_image_describe",
			isData: isImageDescribeResult,
			collapsed: formatImageDescribeCollapsed,
			expanded: formatImageDescribeExpanded,
		});
	},
};

function formatImageDescribeCollapsed(result: ImageDescribeResult): string {
	const input = result.image
		? `${result.image.kind} ${result.image.mimeType} (${result.image.sizeBytes} bytes)`
		: "no validated image";
	if (result.error) {
		return appendExpansionHint(
			[
				`Image input ${result.image ? "validated" : "not accepted"}: ${input}`,
				truncateToolText(result.error.message, 220),
			],
			"image validation and capability details",
		).join("\n");
	}
	return appendExpansionHint(
		[
			`Image description completed: ${input}`,
			truncateToolText(result.caption ?? "", 240),
		],
		"full image description",
	).join("\n");
}

function formatImageDescribeExpanded(
	result: ImageDescribeResult,
	shell: PiToolShell,
): string {
	const imageLines = result.image
		? [
				`image.kind: ${result.image.kind}`,
				`image.mimeType: ${result.image.mimeType}`,
				`image.sizeBytes: ${result.image.sizeBytes}`,
				result.image.kind === "path"
					? `image.path: ${result.image.path}`
					: undefined,
			]
		: ["image: none"];
	return [
		resultText(result),
		`mode: ${result.mode}`,
		...imageLines,
		result.error ? `code: ${result.error.code}` : undefined,
		result.error?.phase ? `phase: ${result.error.phase}` : undefined,
		...resultMetadataLines(shell),
	]
		.filter(Boolean)
		.join("\n");
}

function isImageDescribeResult(value: unknown): value is ImageDescribeResult {
	return (
		isRecord(value) &&
		value.provider === "gemini-acp" &&
		typeof value.mode === "string" &&
		typeof value.responseLength === "number" &&
		typeof value.truncated === "boolean"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(result: ImageDescribeResult): string {
	if (result.error) return result.error.message;
	const input = result.image
		? `${result.image.kind === "path" ? result.image.path : result.image.kind} (${result.image.mimeType}, ${result.image.sizeBytes} bytes)`
		: "image";
	const cache = cacheMarker(result);
	return result.caption
		? `${cache}Gemini ACP image description for ${input}:\n${result.caption}`
		: `${cache}Gemini ACP image description completed for ${input}.`;
}

function cacheMarker(result: ImageDescribeResult): string {
	const status = (result as { cacheStatus?: { hit?: boolean; ageMs?: number } })
		.cacheStatus;
	return status?.hit
		? `[cache: hit, age ${Math.round((status.ageMs ?? 0) / 1000)}s]\n`
		: "";
}

function imageDescribeToolUpdate(
	onUpdate: ToolUpdate | undefined,
): ((update: PromptWorkflowUpdate) => Promise<void>) | undefined {
	if (!onUpdate) return undefined;
	return async (update) => {
		await onUpdate(
			toolResult({
				text: update.text,
				data: update,
				status: update.type === "chunk" ? "streaming" : "running",
			}),
		);
	};
}
