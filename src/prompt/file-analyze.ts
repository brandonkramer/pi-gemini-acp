import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	searchSessionCwd,
	type GeminiAcpCommandSettings,
	type GeminiAcpPromptPart,
} from "../acp/client.js";
import {
	AcpProcessSession,
	type GeminiAcpProcessSessionFactory,
} from "../acp/session.js";
import { requirePermissionCapability } from "../config/permission-policy.js";
import type {
	GeminiAcpAuthProbe,
	StatusCommandChecker,
} from "../config/status.js";
import { storeResult } from "../storage/results.js";
import type { GeminiAcpConfig, StructuredError } from "../types.js";
import {
	abortedResultEnvelope,
	isAbortError,
	providerError,
} from "./provider-result.js";
import { runProviderPrompt } from "./run.js";
import {
	readFileAnalyzeCache,
	writeFileAnalyzeCache,
} from "./file-analyze-cache.js";
import {
	type ValidatedAnalyzeFile,
	validateAnalyzeFiles,
} from "./file-analyze-validation.js";
export { FILE_ANALYZE_MAX_BYTES } from "./file-analyze-validation.js";
export type { ValidatedAnalyzeFile } from "./file-analyze-validation.js";

export const FILE_ANALYZE_MAX_FILES = 5;
const FILE_ANALYZE_INLINE_LIMIT = 4_000;

/** Caller-provided local file analysis request, validated before ACP receives file references. */
export interface FileAnalyzeOptions {
	paths: string[];
	instructions: string;
	cwd?: string;
	config?: GeminiAcpConfig;
	rootDir?: string;
	bypassCache?: boolean;
}

/** Callback that may persist exact Gemini CLI folder trust after user consent. */
export type FileAnalyzeTrustHandler = (
	folderPath: string,
	signal?: AbortSignal,
) => Promise<boolean>;

/** Dependencies for tests and controlled ACP probing. */
export interface FileAnalyzeDeps {
	acpSessionFactory?: GeminiAcpProcessSessionFactory;
	commandExists?: StatusCommandChecker;
	authProbe?: GeminiAcpAuthProbe;
	trustFolder?: FileAnalyzeTrustHandler;
}

/** Capability-gated file-analysis result. */
export interface FileAnalyzeResult {
	provider: "gemini-acp";
	text: string;
	files: ValidatedAnalyzeFile[];
	supported: boolean;
	transport: "resource_link" | "unsupported";
	responseLength?: number;
	truncated?: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

/**
 * Runs file analysis through Gemini ACP resource links after validating explicit paths.
 *
 * Only caller-provided regular files under `cwd` are referenced. Hidden paths,
 * symlinks, directories, secret-like names, and large files are rejected before
 * ACP sees them. Files are passed as ACP `resource_link` parts so Gemini CLI owns
 * provider transport while Pi keeps an allowlist for client-side read requests.
 */
export async function runFileAnalyze(
	options: FileAnalyzeOptions,
	deps: FileAnalyzeDeps = {},
	signal?: AbortSignal,
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

	if (signal?.aborted) return abortedInputResult();
	const validation = await validateAnalyzeFiles(options.paths, options.cwd);
	if (signal?.aborted) return abortedInputResult();
	if (validation.error)
		return { ...emptyFileAnalyzeResult(), error: validation.error };

	const cached = await readFileAnalyzeCache(
		options,
		instructions,
		validation.files,
	).catch(() => undefined);
	if (cached) return cached;

	const sessionFactory = deps.acpSessionFactory ?? AcpProcessSession.start;
	const firstAttempt = await executeFileAnalyzePrompt({
		deps,
		files: validation.files,
		instructions,
		options,
		sessionFactory,
		sessionCwd: searchSessionCwd(undefined),
		signal,
	});
	if (!firstAttempt.error || !isTrustRequiredError(firstAttempt.error)) {
		await writeFileAnalyzeCache(
			options,
			instructions,
			validation.files,
			firstAttempt,
		).catch(() => undefined);
		return firstAttempt;
	}
	const trustedFolderPath = trustedFolderForFiles(
		validation.files,
		validation.rootDir,
	);
	const trusted = await requestFolderTrust(
		deps.trustFolder,
		trustedFolderPath,
		signal,
		firstAttempt,
	);
	if (trusted !== true) return trusted;
	const trustedResult = await executeFileAnalyzePrompt({
		deps,
		files: validation.files,
		instructions,
		options,
		sessionFactory,
		sessionCwd: trustedFolderPath,
		signal,
	});
	await writeFileAnalyzeCache(
		options,
		instructions,
		validation.files,
		trustedResult,
	).catch(() => undefined);
	return trustedResult;
}

async function requestFolderTrust(
	trustFolder: FileAnalyzeTrustHandler | undefined,
	folderPath: string,
	signal: AbortSignal | undefined,
	fallback: FileAnalyzeResult,
): Promise<true | FileAnalyzeResult> {
	if (!trustFolder) return fallback;
	try {
		return (await trustFolder(folderPath, signal)) ? true : fallback;
	} catch (cause) {
		if (isAbortError(cause)) return abortedProviderResult(fallback.files);
		return {
			...emptyFileAnalyzeResult(),
			files: fallback.files,
			error: providerError(
				"GEMINI_ACP_TRUST_REQUIRED",
				"provider_prompt",
				trustRequiredMessage(
					cause instanceof Error
						? cause.message
						: "Gemini CLI folder trust was not saved.",
				),
			),
		};
	}
}

interface FileAnalyzePromptAttempt {
	deps: FileAnalyzeDeps;
	files: ValidatedAnalyzeFile[];
	instructions: string;
	options: FileAnalyzeOptions;
	sessionFactory: GeminiAcpProcessSessionFactory;
	sessionCwd: string;
	signal?: AbortSignal;
}

async function executeFileAnalyzePrompt(
	attempt: FileAnalyzePromptAttempt,
): Promise<FileAnalyzeResult> {
	const promptResult = await runProviderPrompt(
		{
			prompt: attempt.instructions,
			parts: fileAnalyzePromptParts(attempt.instructions, attempt.files),
			cwd: attempt.sessionCwd,
			config: attempt.options.config,
			rootDir: attempt.options.rootDir,
			requireSearchGrounding: false,
			requestSummary: {
				toolName: "gemini_file_analyze",
				action: "Sending file analysis prompt",
				subject: attempt.files.map((file) => file.path).join(", "),
				arguments: { fileCount: attempt.files.length },
			},
			commandSettingsTransform: (settings) =>
				withAllowedReadPaths(settings, attempt.files),
			prePromptCheck: ({ settings }) =>
				requirePermissionCapability(
					settings?.permissionPolicy,
					"filesystemRead",
				),
			errorClassification: {
				abortedMessage: "Gemini ACP file analysis was aborted.",
				failedMessage: "Gemini ACP file analysis failed.",
				trustRequiredMessage,
			},
			promptExecutor: async ({ commandSettings, request }, signal) => {
				let session:
					| Awaited<ReturnType<GeminiAcpProcessSessionFactory>>
					| undefined;
				try {
					session = await attempt.sessionFactory(commandSettings, signal);
					const initializeResult = await session.initialize();
					if (!initializeResult.promptCapabilities.embeddedContext) {
						return {
							text: "",
							error: providerError(
								"GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE",
								"capability_preflight",
								"Gemini ACP file/document resource-link support is not advertised by this ACP command.",
							),
						};
					}
					const sessionId = await session.newSession(
						request.cwd ?? attempt.sessionCwd,
					);
					return await session.prompt(
						sessionId,
						request.parts ??
							fileAnalyzePromptParts(attempt.instructions, attempt.files),
						undefined,
						{ signal },
					);
				} finally {
					await session?.close();
				}
			},
		},
		attempt.deps,
		attempt.signal,
	);
	if (promptResult.error) {
		return {
			...emptyFileAnalyzeResult(),
			files: attempt.files,
			error: promptResult.error,
		};
	}
	return await compactFileAnalyzeResult(
		promptResult.text,
		attempt.files,
		attempt.options,
	);
}

function trustedFolderForFiles(
	files: ValidatedAnalyzeFile[],
	rootDir: string,
): string {
	return files.length === 1 ? path.dirname(files[0].resolvedPath) : rootDir;
}

function fileAnalyzePromptParts(
	instructions: string,
	files: ValidatedAnalyzeFile[],
): GeminiAcpPromptPart[] {
	return [
		{
			type: "text",
			text: [
				"Analyze only the attached explicit file resource links.",
				"Do not inspect unrelated workspace files.",
				`Instructions: ${instructions}`,
				"Files:",
				...files.map(
					(file) =>
						`- @${file.relativePath} (${file.mimeType}, ${file.sizeBytes} bytes)`,
				),
			].join("\n"),
		},
		...files.map((file) => ({
			type: "resource_link" as const,
			uri: pathToFileURL(file.resolvedPath).href,
			name: file.relativePath,
			title: file.path,
			mimeType: file.mimeType,
			size: file.sizeBytes,
		})),
	];
}

async function compactFileAnalyzeResult(
	text: string,
	files: ValidatedAnalyzeFile[],
	options: FileAnalyzeOptions,
): Promise<FileAnalyzeResult> {
	const responseLength = text.length;
	if (responseLength <= FILE_ANALYZE_INLINE_LIMIT) {
		return {
			provider: "gemini-acp",
			text,
			files,
			supported: true,
			transport: "resource_link",
			responseLength,
			truncated: false,
		};
	}
	const stored = await storeResult(
		{ provider: "gemini-acp", tool: "gemini_file_analyze", files, text },
		{ rootDir: options.rootDir },
	);
	return {
		provider: "gemini-acp",
		text: `${text.slice(0, FILE_ANALYZE_INLINE_LIMIT)}…`,
		files,
		supported: true,
		transport: "resource_link",
		responseLength,
		truncated: true,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

function withAllowedReadPaths(
	settings: GeminiAcpCommandSettings,
	files: ValidatedAnalyzeFile[],
): GeminiAcpCommandSettings {
	return {
		...settings,
		allowedReadPaths: files.map((file) => file.resolvedPath),
	};
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

function abortedInputResult(): FileAnalyzeResult {
	return abortedResultEnvelope(
		emptyFileAnalyzeResult(),
		"input_validation",
		"Gemini ACP file analysis was aborted before ACP received file references.",
	);
}

function abortedProviderResult(
	files: ValidatedAnalyzeFile[],
): FileAnalyzeResult {
	return abortedResultEnvelope(
		{ ...emptyFileAnalyzeResult(), files },
		"provider_prompt",
		"Gemini ACP file analysis was aborted.",
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

function isTrustRequiredError(error: StructuredError): boolean {
	return error.code === "GEMINI_ACP_TRUST_REQUIRED";
}

function trustRequiredMessage(message: string): string {
	return `${message}\n\nGemini CLI appears to require folder trust for this ACP session. In interactive Pi, approve the trust prompt when offered; otherwise run /gemini-config trust or trust the exact folder in Gemini CLI, then retry.`;
}
