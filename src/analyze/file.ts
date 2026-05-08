/**
 * @fileoverview Internal file-analysis route used by the gemini_analyze umbrella tool.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import { trustGeminiCliFolder } from "../config/gemini-cli-trust.js";
import {
	FILE_ANALYZE_MAX_FILES,
	type FileAnalyzeOptions,
	type FileAnalyzeResult,
	runFileAnalyze,
} from "../prompt/file-analyze.js";
import type { PiToolShell, ResultEnvelope, StructuredError } from "../types.js";
import type {
	ToolExecutionContext,
	ToolRenderResultOptions,
	ToolUpdate,
} from "../tools/define.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	truncateToolText,
} from "../tools/gemini-rendering.js";
import { errorResult, toolResult } from "../tools/result.js";

const analyzeFileParamsSchema = Type.Object({
	paths: Type.Array(
		Type.String({
			minLength: 1,
			description:
				"Explicit local file path; hidden/symlink/secret paths refused.",
		}),
		{
			minItems: 1,
			maxItems: FILE_ANALYZE_MAX_FILES,
			description: "Explicit file paths; validated before ACP resource links.",
		},
	),
	instructions: Type.String({
		minLength: 1,
		description: "Analysis instructions for the files.",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Base dir for resolving paths; no scanning." }),
	),
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response cache." }),
	),
});

type Params = Static<typeof analyzeFileParamsSchema>;

export const analyzeFileRoute = {
	async execute(
		_toolCallId: string,
		params: Params,
		signal: AbortSignal,
		onUpdate?: ToolUpdate,
		ctx?: ToolExecutionContext,
	) {
		await emitFileAnalyzeProgress(params, onUpdate);
		const result = await runFileAnalyze(
			params as FileAnalyzeOptions,
			{ trustFolder: fileAnalyzeTrustHandler(ctx) },
			signal,
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
		return boxedToolText(
			dimToolText(formatFileAnalyzeToolDisplay(result, options), theme),
		);
	},
};

function fileAnalyzeTrustHandler(ctx: ToolExecutionContext | undefined) {
	if (!ctx?.hasUI || !ctx.ui) return undefined;
	return async (folderPath: string, signal?: AbortSignal): Promise<boolean> => {
		const confirmed = await ctx.ui?.confirm(
			"Trust folder for Gemini ACP file analysis?",
			[
				`Gemini CLI reported that folder trust may be required for: ${folderPath}`,
				"Trusting this exact folder lets Gemini CLI load local workspace configuration for ACP sessions in that folder.",
				"Pi filesystem permissions remain separate: this tool will still allow only the explicit validated file paths for this request.",
				"Decline to stop file analysis without changing Gemini CLI trust settings.",
			].join("\n\n"),
			{ signal },
		);
		if (!confirmed) return false;
		await trustGeminiCliFolder(folderPath);
		return true;
	};
}

async function emitFileAnalyzeProgress(
	params: Params,
	onUpdate: ToolUpdate | undefined,
): Promise<void> {
	if (!onUpdate) return;
	const fileList = params.paths.join(", ");
	await onUpdate(
		toolResult({
			text: `Analyzing ${params.paths.length} explicit file${params.paths.length === 1 ? "" : "s"} via Gemini ACP resource links: ${fileList}. Instructions length: ${params.instructions.length} chars.`,
			status: "streaming",
			data: {
				progress: {
					type: "file-analyze-start",
					paths: params.paths,
					cwd: params.cwd,
					instructionLength: params.instructions.length,
				},
			},
		}),
	);
}

interface FileAnalyzeProgressData {
	progress: {
		type: "file-analyze-start";
		paths: string[];
		cwd?: string;
		instructionLength: number;
	};
}

function formatFileAnalyzeToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (isFileAnalyzeProgressData(details.data)) {
		return formatCollapsedOrExpanded(details.data, options, {
			collapsed: formatFileAnalyzeProgressCollapsed,
			expanded: formatFileAnalyzeProgressExpanded,
		});
	}
	if (isFileAnalyzeResult(details.data)) {
		return formatCollapsedOrExpanded(details.data, options, {
			collapsed: formatFileAnalyzeResultCollapsed,
			expanded: (value) => formatFileAnalyzeResultExpanded(value, result),
		});
	}
	if (details.error) return formatError(details.error, options);
	return result.content[0]?.text ?? "gemini_file_analyze";
}

function formatFileAnalyzeProgressCollapsed(
	value: FileAnalyzeProgressData,
): string {
	return `Analyzing ${value.progress.paths.length} file${value.progress.paths.length === 1 ? "" : "s"}: ${truncateToolText(value.progress.paths.join(", "), 180)}`;
}

function formatFileAnalyzeProgressExpanded(
	value: FileAnalyzeProgressData,
): string {
	return [
		"gemini_file_analyze progress",
		`phase: ${value.progress.type}`,
		`paths: ${value.progress.paths.join(", ")}`,
		value.progress.cwd ? `cwd: ${value.progress.cwd}` : undefined,
		`instructionLength: ${value.progress.instructionLength}`,
	]
		.filter(Boolean)
		.join("\n");
}

function formatFileAnalyzeResultCollapsed(value: FileAnalyzeResult): string {
	if (value.error) {
		return `${value.error.message} ${expandedToolOutputHint("error details")}`;
	}
	const files = value.files.map((file) => file.path).join(", ");
	return [
		`Analyzed ${value.files.length} file${value.files.length === 1 ? "" : "s"}: ${truncateToolText(files, 140)}`,
		truncateToolText(value.text, 260),
		expandedToolOutputHint("full file-analysis output"),
	]
		.filter(Boolean)
		.join("\n");
}

function formatFileAnalyzeResultExpanded(
	value: FileAnalyzeResult,
	result: PiToolShell,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	const lines = [
		resultText(value),
		`transport: ${value.transport}`,
		`supported: ${value.supported}`,
		value.responseLength !== undefined
			? `responseLength: ${value.responseLength}`
			: undefined,
		value.responseId ? `responseId: ${value.responseId}` : undefined,
		value.fullOutputPath
			? `fullOutputPath: ${value.fullOutputPath}`
			: undefined,
		details.error ? formatStructuredError(details.error) : undefined,
	];
	return lines.filter(Boolean).join("\n");
}

function formatError(
	error: StructuredError,
	options: ToolRenderResultOptions,
): string {
	return formatCollapsedOrExpanded(error, options, {
		collapsed: (value) => value.message,
		expanded: formatStructuredError,
	});
}

function formatStructuredError(error: StructuredError): string {
	return [
		error.message,
		`code: ${error.code}`,
		error.phase ? `phase: ${error.phase}` : undefined,
		error.provider ? `provider: ${error.provider}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function isFileAnalyzeProgressData(
	value: unknown,
): value is FileAnalyzeProgressData {
	if (!isRecord(value) || !isRecord(value.progress)) return false;
	return (
		value.progress.type === "file-analyze-start" &&
		Array.isArray(value.progress.paths)
	);
}

function isFileAnalyzeResult(value: unknown): value is FileAnalyzeResult {
	return (
		isRecord(value) &&
		value.provider === "gemini-acp" &&
		Array.isArray(value.files) &&
		typeof value.text === "string" &&
		typeof value.supported === "boolean"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(result: FileAnalyzeResult): string {
	if (result.error) {
		const fileCount = result.files.length;
		const suffix = fileCount
			? ` Validated ${fileCount} explicit file path${fileCount === 1 ? "" : "s"}.`
			: "";
		return `${result.error.message}${suffix}`;
	}
	const files = result.files
		.map((file) => `${file.path} (${file.sizeBytes} bytes)`)
		.join(", ");
	const stored = result.truncated
		? `\nFull output stored as responseId ${result.responseId}.`
		: "";
	return `${cacheMarker(result)}Gemini ACP file analysis completed for ${result.files.length} file${result.files.length === 1 ? "" : "s"}: ${files}\n\n${result.text}${stored}`;
}

function cacheMarker(result: FileAnalyzeResult): string {
	const status = (result as { cacheStatus?: { hit?: boolean; ageMs?: number } })
		.cacheStatus;
	return status?.hit
		? `[cache: hit, age ${Math.round((status.ageMs ?? 0) / 1000)}s]\n`
		: "";
}
