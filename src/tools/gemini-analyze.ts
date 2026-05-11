/**
 * @file Aggregate Gemini ACP local file and image analysis tool with resource-link preflight
 *   delegation.
 */
import { type Static, Type } from "@earendil-works/pi-ai";

import { analyzeFileRoute } from "../analyze/file.js";
import { analyzeImageRoute } from "../analyze/image.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import { defineGeminiTool } from "./define.js";
import { renderGeminiToolCallTitle } from "./gemini-rendering.js";

const analyzeKindSchema = Type.Enum({ file: "file", image: "image" });
const imageModeSchema = Type.Enum({
	caption: "caption",
	objects: "objects",
	ocr: "ocr",
	detailed: "detailed",
});

export const geminiAnalyzeSchema = Type.Object({
	kind: analyzeKindSchema,
	paths: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })),
	imagePath: Type.Optional(Type.String()),
	imageDataBase64: Type.Optional(Type.String()),
	mimeType: Type.Optional(Type.String()),
	instructions: Type.Optional(Type.String()),
	mode: Type.Optional(imageModeSchema),
	cwd: Type.Optional(Type.String()),
	bypassCache: Type.Optional(Type.Boolean()),
});

type Params = Static<typeof geminiAnalyzeSchema>;

export const geminiAnalyzeTool = defineGeminiTool({
	name: "gemini_analyze",
	label: "Gemini Analyze",
	description: "Explicit file/image paths;ACP links;path/read preflight;b64 validate-only",
	parameters: geminiAnalyzeSchema,
	execute(toolCallId, params: Params, signal, onUpdate, ctx) {
		if (params.kind === "file") {
			return analyzeFileRoute.execute(
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
		return analyzeImageRoute.execute(
			toolCallId,
			{
				imagePath: params.imagePath,
				imageDataBase64: params.imageDataBase64,
				mimeType: params.mimeType,
				mode: params.mode as "caption" | "objects" | "ocr" | "detailed" | undefined,
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
		const target = isImageDescribeResult(result) ? analyzeImageRoute : analyzeFileRoute;
		return target.renderResult(result, options, theme, context);
	},
});

function isImageDescribeResult(result: PiToolShell): boolean {
	const data = (result.details as Partial<ResultEnvelope<unknown>>).data;
	return Boolean(
		data && typeof data === "object" && ("image" in data || "caption" in data || "objects" in data),
	);
}
