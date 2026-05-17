import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getCachedGeminiAcpClient,
	warmCachedGeminiAcpPromptClient,
} from "../../acp/client-cache.ts";
import { ensureDir, resolveStoragePaths } from "../../storage/paths.ts";
import type { GeminiAcpConfig } from "../../types.ts";
import { registerGeminiAcpModelProvider } from "../provider.ts";
import { withEnv } from "./env-helpers.ts";

vi.mock("../../acp/client-cache.ts", () => {
	return {
		getCachedGeminiAcpClient: vi.fn(() => ({
			prompt: vi.fn(),
			search: vi.fn(),
		})),
		warmCachedGeminiAcpPromptClient: vi.fn(async () => undefined),
	};
});

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-provider-"));
	vi.clearAllMocks();
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("registerGeminiAcpModelProvider", () => {
	it("does not register when pi lacks registerProvider", async () => {
		const pi = {};
		await expect(registerGeminiAcpModelProvider(pi, undefined)).resolves.toBeUndefined();
	});

	it("does not register when buildGeminiAcpProviderConfig returns undefined", async () => {
		const pi = { registerProvider: vi.fn() };
		await withEnv("PI_GEMINI_ACP_COMMAND", "__nonexistent_gemini_command__", async () => {
			await registerGeminiAcpModelProvider(pi, undefined);
			expect(pi.registerProvider).not.toHaveBeenCalled();
		});
	});

	it("registers the provider and prewarms prompt with primary account env when accounts are configured", async () => {
		await writeConfig(rootDir, {
			providers: {
				"gemini-acp": {
					enabled: true,
					command: "node",
					args: ["--acp"],
					authenticated: true,
					searchGroundingAvailable: true,
				},
				accounts: {
					entries: [
						{ name: "primary", env: { GEMINI_CLI_HOME: "/tmp/gemini-primary" } },
						{ name: "secondary", env: { GEMINI_CLI_HOME: "/tmp/gemini-secondary" } },
					],
				},
			},
		});
		const pi = { registerProvider: vi.fn() };

		await registerGeminiAcpModelProvider(pi, rootDir);

		// Provider must be registered — the streamSimple will route through executeWithAccountPool
		// at call time, so no getCachedGeminiAcpClient call happens during registration.
		expect(pi.registerProvider).toHaveBeenCalledTimes(1);
		// Prewarm still uses primary account env (best-effort startup warm, not pool-aware).
		const warmSettings = vi.mocked(warmCachedGeminiAcpPromptClient).mock.calls[0]?.[0];
		expect(warmSettings?.env).toEqual({ GEMINI_CLI_HOME: "/tmp/gemini-primary" });
		expect(vi.mocked(getCachedGeminiAcpClient)).not.toHaveBeenCalled();
	});

	it("does not let best-effort prompt prewarm rejection escape provider registration", async () => {
		await writeConfig(rootDir, {
			providers: {
				"gemini-acp": {
					enabled: true,
					command: "node",
					args: ["--acp"],
					authenticated: true,
					searchGroundingAvailable: true,
				},
			},
		});
		const catchSpy = vi.fn(() => Promise.resolve());
		const warmPromise = { catch: catchSpy } as unknown as Promise<void>;
		vi.mocked(warmCachedGeminiAcpPromptClient).mockReturnValueOnce(warmPromise);
		const pi = { registerProvider: vi.fn() };

		await registerGeminiAcpModelProvider(pi, rootDir);

		expect(pi.registerProvider).toHaveBeenCalledTimes(1);
		expect(catchSpy).toHaveBeenCalledTimes(1);
	});
});

async function writeConfig(configRootDir: string, config: GeminiAcpConfig): Promise<void> {
	const paths = resolveStoragePaths({ rootDir: configRootDir });
	await ensureDir(paths.config);
	await writeFile(path.join(paths.config, "settings.json"), JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
}
