import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type ImageDescribeResult,
	runImageDescribe,
} from "../prompt/image-describe.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import type { PiToolShell } from "../types.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
import {
	appendExpansionHint,
	renderPromptToolResult,
	resultMetadataLines,
} from "./gemini-prompt-rendering.js";
import {
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
import { errorResult, toolResult } from "./result.js";

const imageModeSchema = Type.Union([
	Type.Literal("caption"),
	Type.Literal("objects"),
	Type.Literal("ocr"),
	Type.Literal("detailed"),
]);

export const geminiAcpImageDescribeSchema = Type.Object({
	imagePath: Type.Optional(
		Type.String({
			description:
				"Explicit local image path to validate. Only PNG, JPEG, WebP, and GIF files are accepted; symlinks are not followed.",
		}),
	),
	imageDataBase64: Type.Optional(
		Type.String({
			description:
				"Standard base64 image bytes without a data URI prefix. This input is validated but not sent; use imagePath for Gemini ACP image analysis.",
		}),
	),
	mimeType: Type.Optional(
		Type.String({
			description:
				"Required for imageDataBase64. Supported values: image/png, image/jpeg, image/webp, image/gif.",
		}),
	),
	mode: Type.Optional(imageModeSchema),
	instructions: Type.Optional(
		Type.String({
			description:
				"Optional caller instructions for caption, object, OCR, or detailed image analysis.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Optional directory used only to resolve relative image paths for safety validation; no directory scanning is performed.",
		}),
	),
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response-cache lookup for this call." }),
	),
});

type Params = Static<typeof geminiAcpImageDescribeSchema>;

export const geminiAcpImageDescribeTool = defineGeminiTool({
	name: "gemini_image_describe",
	label: "Gemini ACP Image Describe",
	description:
		"Analyze explicit local image paths through Gemini ACP resource links after conservative path validation and filesystem-read permission preflight.",
	parameters: geminiAcpImageDescribeSchema,
	async execute(_toolCallId, params: Params, signal, onUpdate) {
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
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_image_describe",
			stateKey: "geminiImageDescribeTitle",
		});
	},
	renderResult(result, options, theme) {
		return renderPromptToolResult(result, options, theme, {
			toolName: "gemini_image_describe",
			isData: isImageDescribeResult,
			collapsed: formatImageDescribeCollapsed,
			expanded: formatImageDescribeExpanded,
		});
	},
});

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
