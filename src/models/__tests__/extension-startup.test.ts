/** @file Regression tests for extension startup model-provider timing. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	detectPiScraper: vi.fn(() => ({ active: false })),
	registerGeminiAcpCommands: vi.fn(),
	registerGeminiAcpModelProvider: vi.fn(async () => undefined),
	registerGeminiAcpTools: vi.fn(),
	registerModelAdapter: vi.fn(),
	scheduleGeminiSearchPrewarm: vi.fn(),
	sweepResponseCacheRetention: vi.fn(async () => undefined),
}));

vi.mock("../../adapter/register.ts", () => ({
	registerModelAdapter: mocks.registerModelAdapter,
}));
vi.mock("../../commands/register.ts", () => ({
	registerGeminiAcpCommands: mocks.registerGeminiAcpCommands,
}));
vi.mock("../../models/provider.ts", () => ({
	registerGeminiAcpModelProvider: mocks.registerGeminiAcpModelProvider,
}));
vi.mock("../../research/hydrate.ts", () => ({
	detectPiScraper: mocks.detectPiScraper,
}));
vi.mock("../../search/prewarm.ts", () => ({
	scheduleGeminiSearchPrewarm: mocks.scheduleGeminiSearchPrewarm,
}));
vi.mock("../../storage/retention.ts", () => ({
	sweepResponseCacheRetention: mocks.sweepResponseCacheRetention,
}));
vi.mock("../../tools/register.ts", () => ({
	registerGeminiAcpTools: mocks.registerGeminiAcpTools,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.detectPiScraper.mockReturnValue({ active: false });
	mocks.registerGeminiAcpModelProvider.mockResolvedValue(undefined);
});

describe("registerPiGeminiAcpExtension startup", () => {
	it("awaits Gemini ACP provider registration before resolving the extension factory", async () => {
		const order: string[] = [];
		mocks.registerGeminiAcpModelProvider.mockImplementationOnce(async () => {
			order.push("provider:start");
			await Promise.resolve();
			order.push("provider:done");
		});
		const { default: registerPiGeminiAcpExtension } = await import("../../index.ts");

		const pi = {
			registerProvider: vi.fn(),
			registerTool: vi.fn(),
		};
		const statePromise = registerPiGeminiAcpExtension(pi);
		order.push("factory:returned");

		const state = await statePromise;
		order.push("factory:resolved");

		expect(order).toEqual([
			"provider:start",
			"factory:returned",
			"provider:done",
			"factory:resolved",
		]);
		expect(mocks.registerGeminiAcpModelProvider).toHaveBeenCalledTimes(1);
		expect(state.piScraper.active).toBe(false);
	});
});
