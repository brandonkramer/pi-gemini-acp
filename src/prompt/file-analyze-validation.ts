import { lstat } from "node:fs/promises";
import path from "node:path";

import type { StructuredError } from "../types.js";

/** Maximum accepted bytes for one explicit file-analysis input. */
export const FILE_ANALYZE_MAX_BYTES = 1_000_000;

/** File metadata that passed the conservative file-analysis safety checks. */
export interface ValidatedAnalyzeFile {
	path: string;
	resolvedPath: string;
	relativePath: string;
	sizeBytes: number;
	mimeType: string;
}

/** Validated file-analysis inputs plus the root used to resolve relative paths. */
export interface AnalyzeFilesValidation {
	rootDir: string;
	files: ValidatedAnalyzeFile[];
	error?: StructuredError;
}

/** Validates explicit caller-provided file paths before ACP receives references. */
export async function validateAnalyzeFiles(
	paths: string[],
	cwd = process.cwd(),
): Promise<AnalyzeFilesValidation> {
	const rootDir = path.resolve(cwd);
	const seen = new Set<string>();
	const files: ValidatedAnalyzeFile[] = [];
	for (const inputPath of paths) {
		const trimmed = inputPath.trim();
		if (!trimmed) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_EMPTY_PATH",
					"File paths must be non-empty strings.",
				),
			};
		}
		const resolvedPath = path.resolve(rootDir, trimmed);
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);

		const unsafeReason = unsafePathReason(trimmed, resolvedPath, rootDir);
		if (unsafeReason) return { rootDir, files, error: unsafeReason };

		let stat;
		try {
			stat = await lstat(resolvedPath);
		} catch {
			return {
				rootDir,
				files,
				error: inputError("GEMINI_FILE_ANALYZE_FILE_NOT_FOUND", `File was not found: ${trimmed}`),
			};
		}
		if (stat.isDirectory()) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_DIRECTORY_REJECTED",
					`Directories are not supported: ${trimmed}`,
				),
			};
		}
		if (stat.isSymbolicLink()) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_SYMLINK_REJECTED",
					`Symbolic links are rejected by default: ${trimmed}`,
				),
			};
		}
		if (!stat.isFile()) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_NOT_A_FILE",
					`Only regular files are supported: ${trimmed}`,
				),
			};
		}
		if (stat.size > FILE_ANALYZE_MAX_BYTES) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_FILE_TOO_LARGE",
					`Files must be ${FILE_ANALYZE_MAX_BYTES} bytes or smaller: ${trimmed}`,
				),
			};
		}
		const relativePath = toPosix(path.relative(rootDir, resolvedPath));
		files.push({
			path: trimmed,
			resolvedPath,
			relativePath,
			sizeBytes: stat.size,
			mimeType: mimeTypeForPath(resolvedPath),
		});
	}
	return { rootDir, files };
}

function unsafePathReason(
	inputPath: string,
	resolvedPath: string,
	rootDir: string,
): StructuredError | undefined {
	if (!isWithinRoot(resolvedPath, rootDir)) {
		return inputError(
			"GEMINI_FILE_ANALYZE_OUTSIDE_CWD_REJECTED",
			`File analysis paths must resolve under cwd: ${inputPath}`,
		);
	}
	const inputSegments = path.normalize(inputPath).split(path.sep).filter(Boolean);
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

function mimeTypeForPath(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".md":
		case ".markdown":
			return "text/markdown";
		case ".json":
			return "application/json";
		case ".html":
		case ".htm":
			return "text/html";
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
		case ".css":
		case ".yaml":
		case ".yml":
		case ".txt":
			return "text/plain";
		default:
			return "text/plain";
	}
}

function isWithinRoot(filePath: string, rootDir: string): boolean {
	const relative = path.relative(rootDir, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function secretLikePath(basename: string, lowerPath: string): boolean {
	return (
		/^(id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts|authorized_keys)$/u.test(basename) ||
		/\.(pem|p12|pfx|key|keystore|jks)$/u.test(basename) ||
		/(^|[-_.])(secret|token|password|passwd|credential|credentials|api[-_]?key)([-_.]|$)/u.test(
			basename,
		) ||
		/(^|\/)\.?(aws|config)\/credentials$/u.test(lowerPath) ||
		/(^|\/)kubeconfig$/u.test(lowerPath)
	);
}

function inputError(code: string, message: string): StructuredError {
	return {
		code,
		phase: "input_validation",
		message,
		retryable: false,
		provider: "gemini-acp",
	};
}
