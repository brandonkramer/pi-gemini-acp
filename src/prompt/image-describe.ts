import { Buffer } from "node:buffer";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { GeminiAcpConfig, StructuredError } from "../types.js";
import type { PromptUpdateHandler } from "./run.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

export const IMAGE_DESCRIBE_MODES = [
	"caption",
	"objects",
	"ocr",
	"detailed",
] as const;

export type SupportedImageMimeType =
	(typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
export type ImageDescribeMode = (typeof IMAGE_DESCRIBE_MODES)[number];

/** Caller-provided image input for future Gemini ACP image description support. */
export interface ImageDescribeOptions {
	imagePath?: string;
	imageDataBase64?: string;
	mimeType?: string;
	mode?: ImageDescribeMode;
	instructions?: string;
	config?: GeminiAcpConfig;
	cwd?: string;
}

/** Normalized image metadata validated before any ACP transport attempt. */
export interface ValidatedImageInput {
	kind: "path" | "base64";
	mimeType: SupportedImageMimeType;
	sizeBytes: number;
	path?: string;
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
 * Validates caller-supplied image inputs and returns explicit unsupported-capability status.
 *
 * Gemini ACP image payload support is not implemented because the current client only
 * exposes text prompts/search and this package has not confirmed ACP image transport shape.
 */
export async function runImageDescribe(
	options: ImageDescribeOptions,
	_signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<ImageDescribeResult> {
	if (_signal?.aborted) return abortedImageDescribeResult(options);
	await onUpdate?.({
		type: "progress",
		phase: "input_validation",
		text: "Validating image input before Gemini ACP capability checks.",
	});
	const validation = await validateImageInput(options);
	if (_signal?.aborted) return abortedImageDescribeResult(options);
	if ("error" in validation)
		return emptyImageDescribeResult(options, validation.error);

	await onUpdate?.({
		type: "progress",
		phase: "capability_preflight",
		text: "Gemini ACP image input transport is not confirmed by this package.",
	});
	return {
		...emptyImageDescribeResult(
			options,
			imageDescribeError(
				"GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED",
				"capability_preflight",
				"gemini_image_describe validates image inputs, but the current Gemini ACP client has no confirmed image-input transport. No image bytes were sent to Gemini ACP.",
			),
		),
		image: validation.image,
	};
}

/** Validates path/base64 image inputs without sending content to Gemini ACP. */
export async function validateImageInput(
	options: ImageDescribeOptions,
): Promise<{ image: ValidatedImageInput } | { error: StructuredError }> {
	const hasPath = Boolean(options.imagePath?.trim());
	const hasData = Boolean(options.imageDataBase64?.trim());
	if (hasPath === hasData) {
		return {
			error: imageDescribeError(
				"GEMINI_IMAGE_DESCRIBE_INPUT_REQUIRED",
				"input_validation",
				"Provide exactly one of imagePath or imageDataBase64.",
			),
		};
	}
	return hasPath ? validateImagePath(options) : validateImageData(options);
}

async function validateImagePath(
	options: ImageDescribeOptions,
): Promise<{ image: ValidatedImageInput } | { error: StructuredError }> {
	const inputPath = options.imagePath?.trim() ?? "";
	if (inputPath.includes("\0")) {
		return inputError(
			"GEMINI_IMAGE_DESCRIBE_INVALID_PATH",
			"Image path contains an invalid NUL byte.",
		);
	}
	const extMime = mimeTypeFromExtension(inputPath);
	if (!extMime) {
		return inputError(
			"GEMINI_IMAGE_DESCRIBE_UNSUPPORTED_TYPE",
			"Unsupported image type. Use PNG, JPEG, WebP, or GIF; SVG and document formats are not accepted.",
		);
	}
	const resolvedPath = path.resolve(options.cwd ?? process.cwd(), inputPath);
	try {
		const stat = await lstat(resolvedPath);
		if (stat.isSymbolicLink()) {
			return inputError(
				"GEMINI_IMAGE_DESCRIBE_SYMLINK_DENIED",
				"Image paths must point directly to a regular file; symbolic links are not followed.",
			);
		}
		if (!stat.isFile()) {
			return inputError(
				"GEMINI_IMAGE_DESCRIBE_NOT_FILE",
				"Image path must point to a regular file.",
			);
		}
		const sizeError = sizeValidationError(stat.size);
		if (sizeError) return { error: sizeError };
		const headerMime = mimeTypeFromHeader(await readHeader(resolvedPath));
		if (headerMime !== extMime) {
			return inputError(
				"GEMINI_IMAGE_DESCRIBE_MIME_MISMATCH",
				"Image file extension and detected content type do not match, or the image header is unsupported.",
			);
		}
		return {
			image: {
				kind: "path",
				mimeType: extMime,
				sizeBytes: stat.size,
				path: resolvedPath,
			},
		};
	} catch (cause) {
		return {
			error: {
				...imageDescribeError(
					"GEMINI_IMAGE_DESCRIBE_PATH_UNREADABLE",
					"input_validation",
					"Image path could not be read for validation.",
				),
				cause,
			},
		};
	}
}

function validateImageData(
	options: ImageDescribeOptions,
): { image: ValidatedImageInput } | { error: StructuredError } {
	const declaredMime = normalizeSupportedMimeType(options.mimeType);
	if (!declaredMime) {
		return inputError(
			"GEMINI_IMAGE_DESCRIBE_MIME_REQUIRED",
			"mimeType is required for imageDataBase64 and must be one of image/png, image/jpeg, image/webp, or image/gif.",
		);
	}
	const normalized = (options.imageDataBase64 ?? "").replace(/\s+/gu, "");
	if (
		!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) ||
		normalized.length % 4 !== 0
	) {
		return inputError(
			"GEMINI_IMAGE_DESCRIBE_INVALID_BASE64",
			"imageDataBase64 must contain valid standard base64 without a data URI prefix.",
		);
	}
	const estimatedBytes = Math.floor((normalized.length * 3) / 4);
	if (estimatedBytes > MAX_IMAGE_BYTES) {
		return {
			error: imageDescribeError(
				"GEMINI_IMAGE_DESCRIBE_IMAGE_TOO_LARGE",
				"input_validation",
				"Image input must be 20 MiB or smaller.",
			),
		};
	}
	const buffer = Buffer.from(normalized, "base64");
	const sizeError = sizeValidationError(buffer.byteLength);
	if (sizeError) return { error: sizeError };
	if (mimeTypeFromHeader(buffer.subarray(0, 16)) !== declaredMime) {
		return inputError(
			"GEMINI_IMAGE_DESCRIBE_MIME_MISMATCH",
			"Declared mimeType does not match the supplied imageDataBase64 header.",
		);
	}
	return {
		image: {
			kind: "base64",
			mimeType: declaredMime,
			sizeBytes: buffer.byteLength,
		},
	};
}

async function readHeader(filePath: string): Promise<Buffer> {
	const file = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(16);
		const result = await file.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, result.bytesRead);
	} finally {
		await file.close();
	}
}

function mimeTypeFromExtension(
	value: string,
): SupportedImageMimeType | undefined {
	switch (path.extname(value).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return undefined;
	}
}

function mimeTypeFromHeader(
	header: Buffer,
): SupportedImageMimeType | undefined {
	if (
		header
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	)
		return "image/png";
	if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
		return "image/jpeg";
	if (
		header.subarray(0, 6).toString("ascii") === "GIF87a" ||
		header.subarray(0, 6).toString("ascii") === "GIF89a"
	)
		return "image/gif";
	if (
		header.subarray(0, 4).toString("ascii") === "RIFF" &&
		header.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "image/webp";
	return undefined;
}

function normalizeSupportedMimeType(
	value: string | undefined,
): SupportedImageMimeType | undefined {
	return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value ?? "")
		? (value as SupportedImageMimeType)
		: undefined;
}

function sizeValidationError(size: number): StructuredError | undefined {
	if (size <= 0)
		return imageDescribeError(
			"GEMINI_IMAGE_DESCRIBE_EMPTY_IMAGE",
			"input_validation",
			"Image input is empty.",
		);
	if (size > MAX_IMAGE_BYTES)
		return imageDescribeError(
			"GEMINI_IMAGE_DESCRIBE_IMAGE_TOO_LARGE",
			"input_validation",
			"Image input must be 20 MiB or smaller.",
		);
	return undefined;
}

function inputError(code: string, message: string): { error: StructuredError } {
	return { error: imageDescribeError(code, "input_validation", message) };
}

function abortedImageDescribeResult(
	options: ImageDescribeOptions,
): ImageDescribeResult {
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

function imageDescribeError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}
