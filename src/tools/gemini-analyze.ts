/**
 * @fileoverview Aggregate Gemini ACP local file and image analysis tool with resource-link preflight delegation.
 */
import { type Static, Type } from "@mariozechner/pi-ai";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiTool } from "./define.js";
import { geminiAcpFileAnalyzeTool } from "./gemini-file-analyze.js";
import { geminiAcpImageDescribeTool } from "./gemini-image-describe.js";
import { renderGeminiToolCallTitle } from "./gemini-rendering.js";

const analyzeKindSchema = Type.Union([
	Type.Literal("file"),
	Type.Literal("image"),
]);
const imageModeSchema = Type.Union([
	Type.Literal("caption"),
	Type.Literal("objects"),
	Type.Literal("ocr"),
	Type.Literal("detailed"),
]);

export const geminiAnalyzeSchema = Type.Object({
	kind: analyzeKindSchema,
	paths: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			maxItems: 5,
			description: "File paths.",
		}),
	),
	imagePath: Type.Optional(Type.String({ description: "Image path." })),
	imageDataBase64: Type.Optional(
		Type.String({ description: "Base64 validation only." }),
	),
	mimeType: Type.Optional(Type.String({ description: "MIME type." })),
	instructions: Type.Optional(Type.String({ description: "Instructions." })),
	mode: Type.Optional(imageModeSchema),
	cwd: Type.Optional(Type.String({ description: "Base dir; no scanning." })),
	bypassCache: Type.Optional(Type.Boolean({ description: "Skip cache." })),
});

type Params = Static<typeof geminiAnalyzeSchema>;

export const geminiAnalyzeTool = defineGeminiTool({
	name: "gemini_analyze",
	label: "Gemini Analyze",
	description:
		"Local file/image paths via Gemini ACP resource links after path and filesystem-read preflight.",
	parameters: geminiAnalyzeSchema,
	execute(toolCallId, params: Params, signal, onUpdate, ctx) {
		if (params.kind === "file") {
			return geminiAcpFileAnalyzeTool.execute(
				toolCallId,
				{
					paths: params.paths ?? [],
					instructions: params.instructions ?? "Analyze these files.",
					cwd: params.cwd,
					bypassCache: params.bypassCache,
				},
				signal,
				onUpdate,
				ctx,
			);
		}
		return geminiAcpImageDescribeTool.execute(
			toolCallId,
			{
				imagePath: params.imagePath,
				imageDataBase64: params.imageDataBase64,
				mimeType: params.mimeType,
				mode: params.mode,
				instructions: params.instructions,
				cwd: params.cwd,
				bypassCache: params.bypassCache,
			},
			signal,
			onUpdate,
			ctx,
		);
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_analyze",
			stateKey: "geminiAnalyzeTitle",
		});
	},
	renderResult(result, options, theme, context) {
		const target = isImageDescribeResult(result)
			? geminiAcpImageDescribeTool
			: geminiAcpFileAnalyzeTool;
		return target.renderResult!(result, options, theme, context);
	},
});

function isImageDescribeResult(result: PiToolShell): boolean {
	const data = (result.details as Partial<ResultEnvelope<unknown>>).data;
	return Boolean(
		data &&
			typeof data === "object" &&
			("image" in data || "caption" in data || "objects" in data),
	);
}
