import { Buffer } from "node:buffer";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeminiAcpCommandSettings } from "../../acp/client.js";
import type { GeminiAcpConfig } from "../../types.js";
import { runImageDescribe, validateImageInput } from "../image-describe.js";

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-image-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("gemini image describe", () => {
	it("sends explicit image paths as ACP resource links", async () => {
		await writeFile(path.join(rootDir, "sample.png"), PNG_BYTES);
		let commandSettings: GeminiAcpCommandSettings | undefined;
		const prompts: unknown[] = [];
		const updates: string[] = [];

		const result = await runImageDescribe(
			{
				imagePath: "sample.png",
				mode: "ocr",
				instructions: "Read visible text.",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			new AbortController().signal,
			(update) => {
				updates.push(update.text);
			},
			{
				commandExists: async () => true,
				acpSessionFactory: async (settings) => {
					commandSettings = settings;
					return {
						initialize: async () => ({
							promptCapabilities: {
								embeddedContext: true,
								image: true,
								audio: false,
							},
						}),
						newSession: async (cwd: string) => {
							expect(cwd).not.toBe(rootDir);
							return "session-1";
						},
						prompt: async (_sessionId, prompt, onUpdate) => {
							prompts.push(prompt);
							await onUpdate?.({
								type: "chunk",
								text: "The image contains",
								accumulatedText: "The image contains",
							});
							return "The image contains the word HELLO.";
						},
						close: async () => undefined,
					};
				},
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.caption).toContain("HELLO");
		expect(result.ocrText).toContain("HELLO");
		expect(result.metadata).toMatchObject({ transport: "resource_link" });
		expect(result.image).toMatchObject({
			kind: "path",
			mimeType: "image/png",
			path: path.join(rootDir, "sample.png"),
			relativePath: "sample.png",
		});
		expect(commandSettings?.allowedReadPaths).toEqual([
			path.join(rootDir, "sample.png"),
		]);
		expect(JSON.stringify(prompts[0])).toContain('"resource_link"');
		expect(JSON.stringify(prompts[0])).toContain(
			pathToFileURL(path.join(rootDir, "sample.png")).href,
		);
		expect(updates).toContain(
			"Analyzing image sample.png (image/png) via Gemini ACP.\n\n● Waiting for Gemini backend...",
		);
		expect(updates).toContain(
			"Analyzing image sample.png (image/png) via Gemini ACP.\n\n● First token received; LLM generating tokens...",
		);
		expect(updates).toContain("The image contains");
	});

	it("passes AbortSignal into ACP image prompt and returns aborted", async () => {
		await writeFile(path.join(rootDir, "sample.png"), PNG_BYTES);
		const controller = new AbortController();

		const result = await runImageDescribe(
			{
				imagePath: "sample.png",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			controller.signal,
			undefined,
			{
				commandExists: async () => true,
				acpSessionFactory: async () => ({
					initialize: async () => ({
						promptCapabilities: {
							embeddedContext: true,
							image: true,
							audio: false,
						},
					}),
					newSession: async () => "session-1",
					prompt: async (_sessionId, _prompt, _onUpdate, options) => {
						expect(options?.signal).toBe(controller.signal);
						throw new DOMException("cancelled", "AbortError");
					},
					close: async () => undefined,
				}),
			},
		);

		expect(result.error).toMatchObject({
			code: "GEMINI_ACP_ABORTED",
			phase: "provider_prompt",
			provider: "gemini-acp",
		});
	});

	it("requires ACP image and embedded context capabilities", async () => {
		await writeFile(path.join(rootDir, "sample.png"), PNG_BYTES);
		let promptCalled = false;

		const result = await runImageDescribe(
			{
				imagePath: "sample.png",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			new AbortController().signal,
			undefined,
			{
				commandExists: async () => true,
				acpSessionFactory: async () => ({
					initialize: async () => ({
						promptCapabilities: {
							embeddedContext: true,
							image: false,
							audio: false,
						},
					}),
					newSession: async () => "session-1",
					prompt: async () => {
						promptCalled = true;
						return "unexpected";
					},
					close: async () => undefined,
				}),
			},
		);

		expect(result.error?.code).toBe("GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED");
		expect(result.error?.phase).toBe("capability_preflight");
		expect(promptCalled).toBe(false);
	});

	it("requires embedded context even when image capability is available", async () => {
		await writeFile(path.join(rootDir, "sample.png"), PNG_BYTES);
		let promptCalled = false;

		const result = await runImageDescribe(
			{
				imagePath: "sample.png",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			new AbortController().signal,
			undefined,
			{
				commandExists: async () => true,
				acpSessionFactory: async () => ({
					initialize: async () => ({
						promptCapabilities: {
							embeddedContext: false,
							image: true,
							audio: false,
						},
					}),
					newSession: async () => "session-1",
					prompt: async () => {
						promptCalled = true;
						return "unexpected";
					},
					close: async () => undefined,
				}),
			},
		);

		expect(result.error?.code).toBe("GEMINI_ACP_IMAGE_INPUT_UNSUPPORTED");
		expect(result.error?.phase).toBe("capability_preflight");
		expect(promptCalled).toBe(false);
	});

	it("truncates ocrText and stores full long image responses", async () => {
		await writeFile(path.join(rootDir, "sample.png"), PNG_BYTES);
		const longText = "OCR ".repeat(1_200);

		const result = await runImageDescribe(
			{
				imagePath: "sample.png",
				mode: "ocr",
				cwd: rootDir,
				rootDir: path.join(rootDir, "storage"),
				config: fileReadConfig(),
			},
			new AbortController().signal,
			undefined,
			{
				commandExists: async () => true,
				acpSessionFactory: async () => ({
					initialize: async () => ({
						promptCapabilities: {
							embeddedContext: true,
							image: true,
							audio: false,
						},
					}),
					newSession: async () => "session-1",
					prompt: async () => longText,
					close: async () => undefined,
				}),
			},
		);

		expect(result.truncated).toBe(true);
		expect(result.responseId).toBeTruthy();
		expect(result.caption?.length).toBeLessThan(longText.length);
		expect(result.ocrText?.length).toBe(result.caption?.length);
		expect(result.ocrText).toContain("…");
	});

	it("requires filesystem read permission", async () => {
		await writeFile(path.join(rootDir, "sample.png"), PNG_BYTES);

		const result = await runImageDescribe(
			{
				imagePath: "sample.png",
				cwd: rootDir,
				config: { providers: { "gemini-acp": baseProviderConfig() } },
			},
			new AbortController().signal,
			undefined,
			{ commandExists: async () => true },
		);

		expect(result.error?.code).toBe("GEMINI_ACP_PERMISSION_POLICY_DENIED");
	});

	it("validates base64 image input but keeps it unsupported", async () => {
		const result = await runImageDescribe({
			imageDataBase64: JPEG_BYTES.toString("base64"),
			mimeType: "image/jpeg",
		});

		expect(result.error?.code).toBe("GEMINI_ACP_IMAGE_BASE64_UNSUPPORTED");
		expect(result.image).toMatchObject({
			kind: "base64",
			mimeType: "image/jpeg",
			sizeBytes: JPEG_BYTES.byteLength,
		});
	});

	it("validates base64 image input with an explicit MIME type", async () => {
		const result = await validateImageInput({
			imageDataBase64: JPEG_BYTES.toString("base64"),
			mimeType: "image/jpeg",
		});

		expect(result).toEqual({
			rootDir: process.cwd(),
			image: {
				kind: "base64",
				mimeType: "image/jpeg",
				sizeBytes: JPEG_BYTES.byteLength,
			},
		});
	});

	it("rejects paths outside cwd", async () => {
		const outside = await mkdtemp(path.join(tmpdir(), "pi-gemini-outside-"));
		try {
			const imagePath = path.join(outside, "outside.png");
			await writeFile(imagePath, PNG_BYTES);

			const result = await validateImageInput({ imagePath, cwd: rootDir });

			expect("error" in result && result.error.code).toBe(
				"GEMINI_IMAGE_DESCRIBE_OUTSIDE_CWD_REJECTED",
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
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

		const result = await validateImageInput({ imagePath, cwd: rootDir });

		expect("error" in result && result.error.code).toBe(
			"GEMINI_IMAGE_DESCRIBE_MIME_MISMATCH",
		);
	});

	it("does not follow symbolic links for image paths", async () => {
		const targetPath = path.join(rootDir, "target.png");
		const linkPath = path.join(rootDir, "linked.png");
		await writeFile(targetPath, PNG_BYTES);
		await symlink(targetPath, linkPath);

		const result = await validateImageInput({
			imagePath: linkPath,
			cwd: rootDir,
		});

		expect("error" in result && result.error.code).toBe(
			"GEMINI_IMAGE_DESCRIBE_SYMLINK_DENIED",
		);
	});
});

function fileReadConfig(): GeminiAcpConfig {
	return {
		providers: {
			"gemini-acp": {
				...baseProviderConfig(),
				permissionPolicy: { filesystemRead: true },
			},
		},
	};
}

function baseProviderConfig() {
	return {
		enabled: true,
		command: "gemini",
		args: ["--acp"],
		authenticated: true,
		searchGroundingAvailable: true,
	};
}
