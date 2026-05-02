import { type Static, Type } from "@mariozechner/pi-ai";
import {
	type ImageDescribeResult,
	runImageDescribe,
} from "../prompt/image-describe.js";
import type { PromptWorkflowUpdate } from "../prompt/run.js";
import { defineGeminiTool, type ToolUpdate } from "./define.js";
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
				"Standard base64 image bytes without a data URI prefix. Provide mimeType with this input.",
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
				"Optional caller instructions for future caption/object/OCR behavior. Not sent while ACP image transport is unsupported.",
		}),
	),
});

type Params = Static<typeof geminiAcpImageDescribeSchema>;

export const geminiAcpImageDescribeTool = defineGeminiTool({
	name: "gemini_image_describe",
	label: "Gemini ACP Image Describe",
	description:
		"Validate explicit image inputs and report Gemini ACP image capability status. Actual image description is disabled until ACP image-input transport is confirmed.",
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
});

function resultText(result: ImageDescribeResult): string {
	if (result.error?.code === "GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED") {
		return "Gemini ACP image input is not enabled: the current client has not confirmed a safe image transport shape. Input was validated and no image bytes were sent.";
	}
	if (result.error) return result.error.message;
	return result.caption
		? `Gemini ACP image description:\n${result.caption}`
		: "Gemini ACP image description completed.";
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
