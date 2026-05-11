import { Buffer } from "node:buffer";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import type { StructuredError } from "../types.ts";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

export const IMAGE_DESCRIBE_MODES = ["caption", "objects", "ocr", "detailed"] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
export type ImageDescribeMode = (typeof IMAGE_DESCRIBE_MODES)[number];

/** Caller-provided image input fields validated before ACP transport. */
export interface ImageInputOptions {
	imagePath?: string;
	imageDataBase64?: string;
	mimeType?: string;
	cwd?: string;
}

/** Normalized image metadata validated before any ACP transport attempt. */
export type ValidatedImageInput =
	| {
			kind: "path";
			mimeType: SupportedImageMimeType;
			sizeBytes: number;
			path: string;
			resolvedPath: string;
			relativePath: string;
	  }
	| {
			kind: "base64";
			mimeType: SupportedImageMimeType;
			sizeBytes: number;
	  };

/** Validates path/base64 image inputs before any provider receives file references. */
export async function validateImageInput(
	options: ImageInputOptions,
): Promise<
	{ image: ValidatedImageInput; rootDir: string } | { error: StructuredError; rootDir: string }
> {
	const rootDir = path.resolve(options.cwd ?? process.cwd());
	const hasPath = Boolean(options.imagePath?.trim());
	const hasData = Boolean(options.imageDataBase64?.trim());
	if (hasPath === hasData) {
		return {
			rootDir,
			error: imageDescribeError(
				"GEMINI_IMAGE_DESCRIBE_INPUT_REQUIRED",
				"input_validation",
				"Provide exactly one of imagePath or imageDataBase64.",
			),
		};
	}
	return hasPath
		? await validateImagePath(options, rootDir)
		: { ...validateImageData(options), rootDir };
}

async function validateImagePath(
	options: ImageInputOptions,
	rootDir: string,
): Promise<
	{ image: ValidatedImageInput; rootDir: string } | { error: StructuredError; rootDir: string }
> {
	const inputPath = options.imagePath?.trim() ?? "";
	if (inputPath.includes("\0")) {
		return withRoot(
			inputError("GEMINI_IMAGE_DESCRIBE_INVALID_PATH", "Image path contains an invalid NUL byte."),
			rootDir,
		);
	}
	const extMime = mimeTypeFromExtension(inputPath);
	if (!extMime) {
		return withRoot(
			inputError(
				"GEMINI_IMAGE_DESCRIBE_UNSUPPORTED_TYPE",
				"Unsupported image type. Use PNG, JPEG, WebP, or GIF; SVG and document formats are not accepted.",
			),
			rootDir,
		);
	}
	const resolvedPath = path.resolve(rootDir, inputPath);
	const unsafeReason = unsafePathReason(inputPath, resolvedPath, rootDir);
	if (unsafeReason) return { error: unsafeReason, rootDir };
	try {
		const stat = await lstat(resolvedPath);
		if (stat.isSymbolicLink()) {
			return withRoot(
				inputError(
					"GEMINI_IMAGE_DESCRIBE_SYMLINK_DENIED",
					"Image paths must point directly to a regular file; symbolic links are not followed.",
				),
				rootDir,
			);
		}
		if (!stat.isFile()) {
			return withRoot(
				inputError("GEMINI_IMAGE_DESCRIBE_NOT_FILE", "Image path must point to a regular file."),
				rootDir,
			);
		}
		const sizeError = sizeValidationError(stat.size);
		if (sizeError) return { error: sizeError, rootDir };
		if (mimeTypeFromHeader(await readHeader(resolvedPath)) !== extMime) {
			return withRoot(
				inputError(
					"GEMINI_IMAGE_DESCRIBE_MIME_MISMATCH",
					"Image file extension and detected content type do not match, or the image header is unsupported.",
				),
				rootDir,
			);
		}
		return {
			rootDir,
			image: {
				kind: "path",
				mimeType: extMime,
				sizeBytes: stat.size,
				path: resolvedPath,
				resolvedPath,
				relativePath: toPosix(path.relative(rootDir, resolvedPath)),
			},
		};
	} catch (cause) {
		return {
			rootDir,
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
	options: ImageInputOptions,
): { image: ValidatedImageInput } | { error: StructuredError } {
	const declaredMime = normalizeSupportedMimeType(options.mimeType);
	if (!declaredMime) {
		return inputError(
			"GEMINI_IMAGE_DESCRIBE_MIME_REQUIRED",
			"mimeType is required for imageDataBase64 and must be one of image/png, image/jpeg, image/webp, or image/gif.",
		);
	}
	const normalized = (options.imageDataBase64 ?? "").replaceAll(/\s+/gu, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4) {
		return inputError(
			"GEMINI_IMAGE_DESCRIBE_INVALID_BASE64",
			"imageDataBase64 must contain valid standard base64 without a data URI prefix.",
		);
	}
	const estimatedBytes = Math.floor((normalized.length * 3) / 4);
	if (estimatedBytes > MAX_IMAGE_BYTES) return { error: tooLargeError() };
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

function mimeTypeFromExtension(value: string): SupportedImageMimeType | undefined {
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

function mimeTypeFromHeader(header: Buffer): SupportedImageMimeType | undefined {
	if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
		return "image/png";
	if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
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

function normalizeSupportedMimeType(value: string | undefined): SupportedImageMimeType | undefined {
	return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value ?? "")
		? (value as SupportedImageMimeType)
		: undefined;
}

function unsafePathReason(
	inputPath: string,
	resolvedPath: string,
	rootDir: string,
): StructuredError | undefined {
	if (!isWithinRoot(resolvedPath, rootDir)) {
		return imageDescribeError(
			"GEMINI_IMAGE_DESCRIBE_OUTSIDE_CWD_REJECTED",
			"input_validation",
			`Image paths must resolve under cwd: ${inputPath}`,
		);
	}
	const inputSegments = path.normalize(inputPath).split(path.sep).filter(Boolean);
	if (inputSegments.some((segment) => segment.startsWith("."))) {
		return imageDescribeError(
			"GEMINI_IMAGE_DESCRIBE_HIDDEN_PATH_REJECTED",
			"input_validation",
			`Hidden files or directories are rejected by default: ${inputPath}`,
		);
	}
	return undefined;
}

function sizeValidationError(size: number): StructuredError | undefined {
	if (size <= 0)
		return imageDescribeError(
			"GEMINI_IMAGE_DESCRIBE_EMPTY_IMAGE",
			"input_validation",
			"Image input is empty.",
		);
	return size > MAX_IMAGE_BYTES ? tooLargeError() : undefined;
}

function tooLargeError(): StructuredError {
	return imageDescribeError(
		"GEMINI_IMAGE_DESCRIBE_IMAGE_TOO_LARGE",
		"input_validation",
		"Image input must be 20 MiB or smaller.",
	);
}

function inputError(code: string, message: string): { error: StructuredError } {
	return { error: imageDescribeError(code, "input_validation", message) };
}

function withRoot(
	result: { error: StructuredError },
	rootDir: string,
): { error: StructuredError; rootDir: string } {
	return { ...result, rootDir };
}

function isWithinRoot(filePath: string, rootDir: string): boolean {
	const relative = path.relative(rootDir, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

export function imageDescribeError(code: string, phase: string, message: string): StructuredError {
	return {
		code,
		phase,
		message,
		retryable: code === "GEMINI_ACP_ABORTED",
		provider: "gemini-acp",
	};
}
