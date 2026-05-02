import { type Static, Type } from "@mariozechner/pi-ai";
import {
	FILE_ANALYZE_MAX_FILES,
	type FileAnalyzeOptions,
	type FileAnalyzeResult,
	runFileAnalyze,
} from "../prompt/file-analyze.js";
import { defineGeminiTool } from "./define.js";
import { errorResult } from "./result.js";

export const geminiAcpFileAnalyzeSchema = Type.Object({
	paths: Type.Array(
		Type.String({
			minLength: 1,
			description:
				"Explicit local file path to consider for analysis. Directories, hidden paths, symlinks, and secret-like files are refused by default.",
		}),
		{
			minItems: 1,
			maxItems: FILE_ANALYZE_MAX_FILES,
			description:
				"Explicit user-provided file paths. The current implementation validates paths but does not read or send file contents until ACP file/document input support is confirmed.",
		},
	),
	instructions: Type.String({
		minLength: 1,
		description:
			"User-provided analysis instructions. Required even though file transport is currently unsupported.",
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Optional directory used only to resolve relative file paths for safety validation; no directory scanning is performed.",
		}),
	),
});

type Params = Static<typeof geminiAcpFileAnalyzeSchema>;

export const geminiAcpFileAnalyzeTool = defineGeminiTool({
	name: "gemini_file_analyze",
	label: "Gemini ACP File Analyze",
	description:
		"Capability-gated local file/document analysis. This version validates explicit paths and returns an unsupported-capability error until Gemini ACP file input support is confirmed.",
	parameters: geminiAcpFileAnalyzeSchema,
	async execute(_toolCallId, params: Params, signal) {
		const result = await runFileAnalyze(params as FileAnalyzeOptions, signal);
		if (result.error) {
			return errorResult(result.error, resultText(result), { data: result });
		}
		return errorResult(
			{
				code: "GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE",
				phase: "capability_preflight",
				message:
					"Gemini ACP file/document input support is not confirmed; no file contents were read or sent.",
				retryable: false,
				provider: "gemini-acp",
			},
			resultText(result),
			{ data: result },
		);
	},
});

function resultText(result: FileAnalyzeResult): string {
	const fileCount = result.files.length;
	const suffix = fileCount
		? ` Validated ${fileCount} explicit file path${fileCount === 1 ? "" : "s"}; no file contents were read or sent.`
		: " No file contents were read or sent.";
	return `${result.error?.message ?? result.text}${suffix}`;
}
