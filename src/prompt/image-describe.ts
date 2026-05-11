/** @file Validated Gemini ACP image description via resource links. */
import { pathToFileURL } from "node:url";

import {
	searchSessionCwd,
	type GeminiAcpCommandSettings,
	type GeminiAcpPromptPart,
} from "../acp/client.ts";
import { emitGeminiBackendProgress, withGeminiBackendProgress } from "../acp/prompt-progress.ts";
import { AcpProcessSession, type GeminiAcpProcessSessionFactory } from "../acp/session.ts";
import { buildGeminiAcpCommandSettings } from "../acp/settings.ts";
import { requirePermissionCapability } from "../config/permission-policy.ts";
import { configFromEnv, loadConfig, withDefaultGeminiAcpConfig } from "../config/settings.ts";
import {
	type GeminiAcpAuthProbe,
	preflightGeminiAcpProvider,
	type StatusCommandChecker,
} from "../config/status.ts";
import { storeResult } from "../storage/results.ts";
import type { GeminiAcpConfig, StructuredError } from "../types.ts";
import { readImageDescribeCache, writeImageDescribeCache } from "./image-describe-cache.ts";
import {
	IMAGE_DESCRIBE_MODES,
	type ImageDescribeMode,
	imageDescribeError,
	SUPPORTED_IMAGE_MIME_TYPES,
	type SupportedImageMimeType,
	type ValidatedImageInput,
	validateImageInput,
} from "./image-describe-input.ts";
import { promptWorkflowProgressEmitter } from "./progress-emitter.ts";
import { isAbortError } from "./provider-result.ts";
import type { PromptUpdateHandler } from "./run.ts";

const IMAGE_DESCRIBE_INLINE_LIMIT = 4_000;
type ValidatedImagePathInput = Extract<ValidatedImageInput, { kind: "path" }>;

export {
	IMAGE_DESCRIBE_MODES,
	type ImageDescribeMode,
	SUPPORTED_IMAGE_MIME_TYPES,
	type SupportedImageMimeType,
	type ValidatedImageInput,
	validateImageInput,
};

/** Caller-provided image input for Gemini ACP image description support. */
export interface ImageDescribeOptions {
	imagePath?: string;
	imageDataBase64?: string;
	mimeType?: string;
	mode?: ImageDescribeMode;
	instructions?: string;
	config?: GeminiAcpConfig;
	cwd?: string;
	rootDir?: string;
	bypassCache?: boolean;
}

/** Dependencies for tests and controlled ACP probing. */
export interface ImageDescribeDeps {
	acpSessionFactory?: GeminiAcpProcessSessionFactory;
	commandExists?: StatusCommandChecker;
	authProbe?: GeminiAcpAuthProbe;
}

/** Image description result shape returned by the public tool adapter. */
export interface ImageDescribeResult {
	provider: "gemini-acp";
	mode: ImageDescribeMode;
	image?: ValidatedImageInput;
	caption?: string;
	objects?: string[];
	ocrText?: string;
	metadata?: Record<string, unknown>;
	responseLength: number;
	truncated: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

/**
 * Describes an explicit local image through Gemini ACP resource links.
 *
 * Pi image attachments arrive as local paths, so provider-backed transport is limited to validated
 * regular image files under `cwd`. Base64 inputs remain validation-only until this package
 * intentionally adds inline ACP image blocks.
 */
export async function runImageDescribe(
	options: ImageDescribeOptions,
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
	deps: ImageDescribeDeps = {},
): Promise<ImageDescribeResult> {
	if (signal?.aborted) return abortedImageDescribeResult(options);
	await onUpdate?.({
		type: "progress",
		phase: "input_validation",
		text: imageDescribeStartText(options),
	});
	const validation = await validateImageInput(options);
	if (signal?.aborted) return abortedImageDescribeResult(options);
	if ("error" in validation) return emptyImageDescribeResult(options, validation.error);
	if (validation.image.kind !== "path") {
		return {
			...emptyImageDescribeResult(options, unsupportedBase64Error()),
			image: validation.image,
		};
	}

	await onUpdate?.({
		type: "progress",
		phase: "capability_preflight",
		text: "Checking Gemini ACP image, resource-link, and filesystem-read capabilities.",
	});
	const loadedConfig =
		options.config ?? configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const config = withDefaultGeminiAcpConfig(loadedConfig);
	const settings = config.providers?.["gemini-acp"];
	const preflight = await preflightGeminiAcpProvider(settings, {
		commandExists: deps.commandExists,
		requireSearchGrounding: false,
		rootDir: options.rootDir,
		signal,
		authProbe: deps.authProbe,
		persistAuthConfirmation: !options.config,
	});
	if (preflight)
		return {
			...emptyImageDescribeResult(options, preflight),
			image: validation.image,
		};
	const permissionError = requirePermissionCapability(settings?.permissionPolicy, "filesystemRead");
	if (permissionError)
		return {
			...emptyImageDescribeResult(options, permissionError),
			image: validation.image,
		};

	const cached = await readImageDescribeCache(options, validation.image).catch(() => undefined);
	if (cached) return cached;

	const commandSettings = withAllowedImagePath(
		buildGeminiAcpCommandSettings(settings),
		validation.image,
	);
	const result = await executeImageDescribeSession({
		commandSettings,
		image: validation.image,
		onUpdate,
		options,
		// oxlint-disable-next-line typescript/unbound-method -- AcpProcessSession.start is static and does not reference `this`
		sessionFactory: deps.acpSessionFactory ?? AcpProcessSession.start,
		signal,
	});
	await writeImageDescribeCache(options, validation.image, result).catch(() => undefined);
	return result;
}

interface ImageDescribeSessionAttempt {
	commandSettings: GeminiAcpCommandSettings;
	image: ValidatedImagePathInput;
	onUpdate?: PromptUpdateHandler;
	options: ImageDescribeOptions;
	sessionFactory: GeminiAcpProcessSessionFactory;
	signal?: AbortSignal;
}

async function executeImageDescribeSession(
	attempt: ImageDescribeSessionAttempt,
): Promise<ImageDescribeResult> {
	let session: Awaited<ReturnType<GeminiAcpProcessSessionFactory>> | undefined;
	try {
		session = await attempt.sessionFactory(attempt.commandSettings, attempt.signal);
		const initializeResult = await session.initialize();
		if (
			!initializeResult.promptCapabilities.image ||
			!initializeResult.promptCapabilities.embeddedContext
		) {
			return {
				...emptyImageDescribeResult(attempt.options, unsupportedTransportError()),
				image: attempt.image,
			};
		}
		const sessionId = await session.newSession(searchSessionCwd(undefined));
		const header = `Analyzing image ${attempt.image.relativePath} (${attempt.image.mimeType}) via Gemini ACP.`;
		await emitGeminiBackendProgress(
			promptWorkflowProgressEmitter(attempt.onUpdate, "provider_wait"),
			"waiting",
			header,
		);
		const promptUpdate = attempt.onUpdate
			? withGeminiBackendProgress(
					async (chunk) => await attempt.onUpdate?.(chunk),
					promptWorkflowProgressEmitter(attempt.onUpdate, "provider_stream"),
					header,
				)
			: undefined;
		const text = await session.prompt(
			sessionId,
			imageDescribePromptParts(attempt.options, attempt.image),
			promptUpdate,
			{ signal: attempt.signal },
		);
		return await compactImageDescribeResult(text, attempt.image, attempt.options);
	} catch (cause) {
		return {
			...emptyImageDescribeResult(attempt.options, providerPromptError(cause)),
			image: attempt.image,
		};
	} finally {
		await session?.close();
	}
}

function imageDescribePromptParts(
	options: ImageDescribeOptions,
	image: ValidatedImagePathInput,
): GeminiAcpPromptPart[] {
	const mode = options.mode ?? "caption";
	const instructions = options.instructions?.trim();
	return [
		{
			type: "text",
			text: [
				"Analyze only the attached explicit image resource link.",
				"Do not inspect unrelated workspace files.",
				`Mode: ${mode}`,
				instructions ? `Instructions: ${instructions}` : undefined,
				`Image: @${image.relativePath} (${image.mimeType}, ${image.sizeBytes} bytes)`,
			]
				.filter(Boolean)
				.join("\n"),
		},
		{
			type: "resource_link",
			uri: pathToFileURL(image.resolvedPath).href,
			name: image.relativePath,
			title: image.path,
			mimeType: image.mimeType,
			size: image.sizeBytes,
		},
	];
}

async function compactImageDescribeResult(
	text: string,
	image: ValidatedImageInput,
	options: ImageDescribeOptions,
): Promise<ImageDescribeResult> {
	const responseLength = text.length;
	const displayText =
		responseLength <= IMAGE_DESCRIBE_INLINE_LIMIT
			? text
			: `${text.slice(0, IMAGE_DESCRIBE_INLINE_LIMIT)}…`;
	const base = imageDescribeResultFromText(displayText, image, options, responseLength);
	if (responseLength <= IMAGE_DESCRIBE_INLINE_LIMIT) return base;
	const stored = await storeResult(
		{ provider: "gemini-acp", tool: "gemini_image_describe", image, text },
		{ rootDir: options.rootDir },
	);
	return {
		...base,
		truncated: true,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

function imageDescribeResultFromText(
	text: string,
	image: ValidatedImageInput,
	options: ImageDescribeOptions,
	responseLength: number,
): ImageDescribeResult {
	const mode = options.mode ?? "caption";
	return {
		provider: "gemini-acp",
		mode,
		image,
		caption: text,
		ocrText: mode === "ocr" ? text : undefined,
		metadata: { transport: "resource_link" },
		responseLength,
		truncated: false,
	};
}

function withAllowedImagePath(
	settings: GeminiAcpCommandSettings,
	image: ValidatedImagePathInput,
): GeminiAcpCommandSettings {
	return {
		...settings,
		allowedReadPaths: [image.resolvedPath],
	};
}

function providerPromptError(cause: unknown): StructuredError {
	return imageDescribeError(
		isAbortError(cause) ? "GEMINI_ACP_ABORTED" : "GEMINI_ACP_FAILED",
		"provider_prompt",
		isAbortError(cause)
			? "Gemini ACP image description was aborted."
			: cause instanceof Error
				? cause.message
				: "Gemini ACP image description failed.",
	);
}

function unsupportedBase64Error(): StructuredError {
	return imageDescribeError(
		"GEMINI_ACP_IMAGE_BASE64_UNSUPPORTED",
		"capability_preflight",
		"Base64 image inputs are validated but not sent; use imagePath so Gemini ACP can read the image through a resource link.",
	);
}

function unsupportedTransportError(): StructuredError {
	return imageDescribeError(
		"GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED",
		"capability_preflight",
		"Gemini ACP image/resource-link support is not advertised by this ACP command.",
	);
}

function abortedImageDescribeResult(options: ImageDescribeOptions): ImageDescribeResult {
	return emptyImageDescribeResult(
		options,
		imageDescribeError(
			"GEMINI_ACP_ABORTED",
			"input_validation",
			"Gemini ACP image description was aborted before any image content was sent.",
		),
	);
}

function emptyImageDescribeResult(
	options: ImageDescribeOptions,
	error?: StructuredError,
): ImageDescribeResult {
	return {
		provider: "gemini-acp",
		mode: options.mode ?? "caption",
		responseLength: 0,
		truncated: false,
		error,
	};
}

function imageDescribeStartText(options: ImageDescribeOptions): string {
	const target = options.imagePath?.trim()
		? `image path ${options.imagePath.trim()}`
		: "base64 image data";
	return `Validating ${target} before Gemini ACP capability checks.`;
}
