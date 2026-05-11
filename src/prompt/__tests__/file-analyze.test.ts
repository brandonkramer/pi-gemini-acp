import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GeminiAcpCommandSettings } from "../../acp/client.js";
import type { GeminiAcpConfig } from "../../types.js";
import { runFileAnalyze } from "../file-analyze.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-file-analyze-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("runFileAnalyze", () => {
	it("validates explicit files and sends ACP resource links", async () => {
		await writeFile(path.join(rootDir, "notes.txt"), "alpha beta", "utf8");
		let commandSettings: GeminiAcpCommandSettings | undefined;
		const prompts: unknown[] = [];
		const updates: string[] = [];

		const result = await runFileAnalyze(
			{
				paths: ["notes.txt"],
				instructions: "Summarize this file.",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			{
				commandExists: async () => true,
				acpSessionFactory: async (settings) => {
					commandSettings = settings;
					return {
						initialize: async () => ({
							promptCapabilities: {
								embeddedContext: true,
								image: false,
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
								text: "The file says",
								accumulatedText: "The file says",
							});
							return "The file says alpha beta.";
						},
						close: async () => undefined,
					};
				},
			},
			undefined,
			(update) => {
				updates.push(update.text);
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.text).toContain("alpha beta");
		expect(result.files).toEqual([
			expect.objectContaining({
				path: "notes.txt",
				resolvedPath: path.join(rootDir, "notes.txt"),
				relativePath: "notes.txt",
				sizeBytes: 10,
			}),
		]);
		expect(result.supported).toBe(true);
		expect(result.transport).toBe("resource_link");
		expect(commandSettings?.allowedReadPaths).toEqual([path.join(rootDir, "notes.txt")]);
		expect(JSON.stringify(prompts[0])).toContain('"resource_link"');
		expect(JSON.stringify(prompts[0])).toContain(
			pathToFileURL(path.join(rootDir, "notes.txt")).href,
		);
		expect(updates).toContain(
			'Sending file analysis prompt: "notes.txt" with fileCount 1 via Gemini ACP default.\n\n● Waiting for Gemini backend...',
		);
		expect(updates).toContain(
			'Sending file analysis prompt: "notes.txt" with fileCount 1 via Gemini ACP default.\n\n● First token received; LLM generating tokens...',
		);
		expect(updates).toContain("The file says");
	});

	it("passes AbortSignal into ACP file prompt and returns aborted", async () => {
		await writeFile(path.join(rootDir, "notes.txt"), "alpha beta", "utf8");
		const controller = new AbortController();

		const result = await runFileAnalyze(
			{
				paths: ["notes.txt"],
				instructions: "Summarize this file.",
				cwd: rootDir,
				config: fileReadConfig(),
			},
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
					prompt: async (_sessionId, _prompt, _onUpdate, options) => {
						expect(options?.signal).toBe(controller.signal);
						throw new DOMException("cancelled", "AbortError");
					},
					close: async () => undefined,
				}),
			},
			controller.signal,
		);

		expect(result.error).toMatchObject({
			code: "GEMINI_ACP_ABORTED",
			phase: "provider_prompt",
			message: "Gemini ACP file analysis was aborted.",
			retryable: true,
			provider: "gemini-acp",
		});
	});

	it("can trust the exact cwd and retry once after trust-shaped failure", async () => {
		await writeFile(path.join(rootDir, "notes.txt"), "alpha beta", "utf8");
		const sessionCwds: string[] = [];
		let trustedFolder: string | undefined;

		const result = await runFileAnalyze(
			{
				paths: ["notes.txt"],
				instructions: "Summarize this file.",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			{
				commandExists: async () => true,
				trustFolder: async (folder) => {
					trustedFolder = folder;
					return true;
				},
				acpSessionFactory: async () => ({
					initialize: async () => ({
						promptCapabilities: {
							embeddedContext: true,
							image: false,
							audio: false,
						},
					}),
					newSession: async (cwd) => {
						sessionCwds.push(cwd);
						return `session-${sessionCwds.length}`;
					},
					prompt: async () => {
						if (sessionCwds.length === 1) {
							throw new Error("FatalUntrustedWorkspaceError: not trusted");
						}
						return "Trusted retry worked.";
					},
					close: async () => undefined,
				}),
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.text).toBe("Trusted retry worked.");
		expect(trustedFolder).toBe(rootDir);
		expect(sessionCwds[0]).not.toBe(rootDir);
		expect(sessionCwds[1]).toBe(rootDir);
	});

	it("returns trust remediation when trust-shaped failure is not approved", async () => {
		await writeFile(path.join(rootDir, "notes.txt"), "alpha beta", "utf8");

		const result = await runFileAnalyze(
			{
				paths: ["notes.txt"],
				instructions: "Summarize this file.",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			{
				commandExists: async () => true,
				trustFolder: async () => false,
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
						throw new Error("Gemini CLI is not running in a trusted directory.");
					},
					close: async () => undefined,
				}),
			},
		);

		expect(result.error?.code).toBe("GEMINI_ACP_TRUST_REQUIRED");
		expect(result.error?.message).toContain("/gemini-config trust");
	});

	it("requires ACP embedded context capability before sending file references", async () => {
		await writeFile(path.join(rootDir, "notes.txt"), "alpha beta", "utf8");
		let promptCalled = false;

		const result = await runFileAnalyze(
			{
				paths: ["notes.txt"],
				instructions: "Summarize this file.",
				cwd: rootDir,
				config: fileReadConfig(),
			},
			{
				commandExists: async () => true,
				acpSessionFactory: async () => ({
					initialize: async () => ({
						promptCapabilities: {
							embeddedContext: false,
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

		expect(result.error?.code).toBe("GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE");
		expect(result.error?.phase).toBe("capability_preflight");
		expect(promptCalled).toBe(false);
	});

	it("rejects directories", async () => {
		await mkdir(path.join(rootDir, "docs"));

		const result = await runFileAnalyze({
			paths: ["docs"],
			instructions: "Analyze docs.",
			cwd: rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_FILE_ANALYZE_DIRECTORY_REJECTED");
		expect(result.files).toEqual([]);
	});

	it("rejects hidden paths by default", async () => {
		await writeFile(path.join(rootDir, ".env"), "TOKEN=secret", "utf8");

		const result = await runFileAnalyze({
			paths: [".env"],
			instructions: "Analyze this file.",
			cwd: rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_FILE_ANALYZE_HIDDEN_PATH_REJECTED");
	});

	it("rejects secret-like files by default before reading content", async () => {
		const result = await runFileAnalyze({
			paths: ["api-token.txt"],
			instructions: "Analyze this file.",
			cwd: rootDir,
		});

		expect(result.error?.code).toBe("GEMINI_FILE_ANALYZE_SECRET_PATH_REJECTED");
	});
});

function fileReadConfig(): GeminiAcpConfig {
	return {
		providers: {
			"gemini-acp": {
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: true,
				searchGroundingAvailable: true,
				permissionPolicy: { filesystemRead: true },
			},
		},
	};
}
