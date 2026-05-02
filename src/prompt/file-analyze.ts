import { lstat } from "node:fs/promises";
import path from "node:path";
import type { StructuredError } from "../types.js";

export const FILE_ANALYZE_MAX_FILES = 5;

/** Caller-provided local file analysis request, validated without reading file contents. */
export interface FileAnalyzeOptions {
	paths: string[];
	instructions: string;
	cwd?: string;
}

/** File metadata that passed the conservative file-analysis safety checks. */
export interface ValidatedAnalyzeFile {
	path: string;
	resolvedPath: string;
	sizeBytes: number;
}

/** Capability-gated file-analysis result. */
export interface FileAnalyzeResult {
	provider: "gemini-acp";
	text: string;
	files: ValidatedAnalyzeFile[];
	supported: false;
	transport: "unsupported";
	error?: StructuredError;
}

/**
 * Validates explicit file-analysis inputs and reports unsupported ACP transport.
 *
 * This deliberately does not read file contents or hand paths to ACP because the
 * current client exposes only prompt/search transport, not confirmed document
 * attachments or a safe provider-side file reference protocol.
 */
export async function runFileAnalyze(
	options: FileAnalyzeOptions,
	_signal?: AbortSignal,
): Promise<FileAnalyzeResult> {
	const instructions = options.instructions.trim();
	if (!instructions) {
		return fileAnalyzeError(
			"GEMINI_FILE_ANALYZE_EMPTY_INSTRUCTIONS",
			"input_validation",
			"File analysis instructions are required.",
		);
	}

	if (!Array.isArray(options.paths) || options.paths.length === 0) {
		return fileAnalyzeError(
			"GEMINI_FILE_ANALYZE_EMPTY_PATHS",
			"input_validation",
			"At least one explicit file path is required.",
		);
	}

	if (options.paths.length > FILE_ANALYZE_MAX_FILES) {
		return fileAnalyzeError(
			"GEMINI_FILE_ANALYZE_TOO_MANY_FILES",
			"input_validation",
			`Analyze at most ${FILE_ANALYZE_MAX_FILES} explicitly provided files at once.`,
		);
	}

	if (_signal?.aborted) return abortedResult();
	const validation = await validateAnalyzeFiles(options.paths, options.cwd);
	if (_signal?.aborted) return abortedResult();
	if (validation.error)
		return { ...emptyFileAnalyzeResult(), error: validation.error };

	return {
		provider: "gemini-acp",
		text: "Gemini ACP file analysis is not available in this extension version because ACP file/document input support is not confirmed.",
		files: validation.files,
		supported: false,
		transport: "unsupported",
		error: providerError(
			"GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE",
			"capability_preflight",
			"Gemini ACP file/document input support is not confirmed; no file contents were read or sent.",
		),
	};
}

async function validateAnalyzeFiles(
	paths: string[],
	cwd = process.cwd(),
): Promise<{ files: ValidatedAnalyzeFile[]; error?: StructuredError }> {
	const seen = new Set<string>();
	const files: ValidatedAnalyzeFile[] = [];
	for (const inputPath of paths) {
		const trimmed = inputPath.trim();
		if (!trimmed) {
			return {
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_EMPTY_PATH",
					"File paths must be non-empty strings.",
				),
			};
		}
		const resolvedPath = path.resolve(cwd, trimmed);
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);

		const unsafeReason = unsafePathReason(trimmed, resolvedPath);
		if (unsafeReason) return { files, error: unsafeReason };

		let stat;
		try {
			stat = await lstat(resolvedPath);
		} catch {
			return {
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_FILE_NOT_FOUND",
					`File was not found: ${trimmed}`,
				),
			};
		}
		if (stat.isDirectory()) {
			return {
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_DIRECTORY_REJECTED",
					`Directories are not supported: ${trimmed}`,
				),
			};
		}
		if (stat.isSymbolicLink()) {
			return {
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_SYMLINK_REJECTED",
					`Symbolic links are rejected by default: ${trimmed}`,
				),
			};
		}
		if (!stat.isFile()) {
			return {
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_NOT_A_FILE",
					`Only regular files are supported: ${trimmed}`,
				),
			};
		}
		files.push({ path: trimmed, resolvedPath, sizeBytes: stat.size });
	}
	return { files };
}

function unsafePathReason(
	inputPath: string,
	resolvedPath: string,
): StructuredError | undefined {
	const inputSegments = path
		.normalize(inputPath)
		.split(path.sep)
		.filter(Boolean);
	if (inputSegments.some((segment) => segment.startsWith("."))) {
		return inputError(
			"GEMINI_FILE_ANALYZE_HIDDEN_PATH_REJECTED",
			`Hidden files or directories are rejected by default: ${inputPath}`,
		);
	}
	const basename = path.basename(resolvedPath).toLowerCase();
	if (secretLikePath(basename, resolvedPath.toLowerCase())) {
		return inputError(
			"GEMINI_FILE_ANALYZE_SECRET_PATH_REJECTED",
			`Secret-like files are rejected by default: ${inputPath}`,
		);
	}
	return undefined;
}

function secretLikePath(basename: string, lowerPath: string): boolean {
	return (
		/^(id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts|authorized_keys)$/u.test(
			basename,
		) ||
		/\.(pem|p12|pfx|key|keystore|jks)$/u.test(basename) ||
		/(^|[-_.])(secret|token|password|passwd|credential|credentials|api[-_]?key)([-_.]|$)/u.test(
			basename,
		) ||
		/(^|\/)\.?(aws|config)\/credentials$/u.test(lowerPath) ||
		/(^|\/)kubeconfig$/u.test(lowerPath)
	);
}

function fileAnalyzeError(
	code: string,
	phase: string,
	message: string,
): FileAnalyzeResult {
	return {
		...emptyFileAnalyzeResult(),
		error: providerError(code, phase, message),
	};
}

function inputError(code: string, message: string): StructuredError {
	return providerError(code, "input_validation", message);
}

function abortedResult(): FileAnalyzeResult {
	return fileAnalyzeError(
		"GEMINI_ACP_ABORTED",
		"input_validation",
		"Gemini ACP file analysis was aborted before any file content was read.",
	);
}

function emptyFileAnalyzeResult(): FileAnalyzeResult {
	return {
		provider: "gemini-acp",
		text: "",
		files: [],
		supported: false,
		transport: "unsupported",
	};
}

function providerError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}
