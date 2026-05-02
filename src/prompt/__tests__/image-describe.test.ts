import { Buffer } from "node:buffer";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImageDescribe, validateImageInput } from "../image-describe.js";

const PNG_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-image-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("gemini image describe validation", () => {
	it("validates an explicit local image path before reporting unsupported ACP transport", async () => {
		const imagePath = path.join(rootDir, "sample.png");
		await writeFile(imagePath, PNG_BYTES);
		const updates: unknown[] = [];

		const result = await runImageDescribe(
			{ imagePath, mode: "ocr" },
			new AbortController().signal,
			(update) => {
				updates.push(update);
			},
		);

		expect(result.error?.code).toBe("GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED");
		expect(result.mode).toBe("ocr");
		expect(result.image).toMatchObject({
			kind: "path",
			mimeType: "image/png",
			sizeBytes: PNG_BYTES.byteLength,
			path: imagePath,
		});
		expect(updates).toEqual([
			expect.objectContaining({ phase: "input_validation" }),
			expect.objectContaining({ phase: "capability_preflight" }),
		]);
	});

	it("validates base64 image input with an explicit MIME type", async () => {
		const result = await validateImageInput({
			imageDataBase64: JPEG_BYTES.toString("base64"),
			mimeType: "image/jpeg",
		});

		expect(result).toEqual({
			image: {
				kind: "base64",
				mimeType: "image/jpeg",
				sizeBytes: JPEG_BYTES.byteLength,
			},
		});
	});

	it("rejects unsupported image file types", async () => {
		const result = await validateImageInput({
			imagePath: path.join(rootDir, "vector.svg"),
		});

		expect("error" in result && result.error.code).toBe(
			"GEMINI_IMAGE_DESCRIBE_UNSUPPORTED_TYPE",
		);
	});

	it("rejects mismatched file extension and image header", async () => {
		const imagePath = path.join(rootDir, "sample.jpg");
		await writeFile(imagePath, PNG_BYTES);

		const result = await validateImageInput({ imagePath });

		expect("error" in result && result.error.code).toBe(
			"GEMINI_IMAGE_DESCRIBE_MIME_MISMATCH",
		);
	});

	it("does not follow symbolic links for image paths", async () => {
		const targetPath = path.join(rootDir, "target.png");
		const linkPath = path.join(rootDir, "linked.png");
		await writeFile(targetPath, PNG_BYTES);
		await symlink(targetPath, linkPath);

		const result = await validateImageInput({ imagePath: linkPath });

		expect("error" in result && result.error.code).toBe(
			"GEMINI_IMAGE_DESCRIBE_SYMLINK_DENIED",
		);
	});
});
