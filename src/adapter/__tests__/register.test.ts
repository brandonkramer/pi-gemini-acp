/**
 * @fileoverview Unit tests for the pi:model-adapter protocol registration.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
	getModelAdapterStatus,
	registerModelAdapter,
	resetModelAdapterEmitted,
	type ModelAdapterRegistrar,
} from "../register.js";

interface MockRegistrar {
	events: {
		on: Mock;
		emit: Mock;
	};
}

function createMockRegistrar(): MockRegistrar {
	return {
		events: {
			on: vi.fn(),
			emit: vi.fn(),
		},
	};
}

describe("registerModelAdapter", () => {
	beforeEach(() => {
		delete process.env.PI_GEMINI_ACP_OFFER_MODEL_ADAPTER;
		resetModelAdapterEmitted();
	});

	it("emits pi:model-adapter/register with correct payload shape", () => {
		const pi = createMockRegistrar();
		registerModelAdapter(pi);
		expect(pi.events.emit).toHaveBeenCalledOnce();
		expect(pi.events.emit).toHaveBeenCalledWith(
			"pi:model-adapter/register",
			expect.objectContaining({
				id: "gemini-acp",
				label: "Gemini (via ACP)",
				capabilities: ["summarize"],
				priority: 50,
				adapter: expect.objectContaining({
					run: expect.any(Function),
				}),
			}),
		);
	});

	it("subscribes to pi:model-adapter/discover and re-emits on receipt", () => {
		const pi = createMockRegistrar();
		registerModelAdapter(pi);
		expect(pi.events.on).toHaveBeenCalledOnce();
		expect(pi.events.on).toHaveBeenCalledWith(
			"pi:model-adapter/discover",
			expect.any(Function),
		);
		const handler = pi.events.on.mock.calls[0][1] as () => void;
		// Clear the initial emit to count only the re-emit
		pi.events.emit.mockClear();
		handler();
		expect(pi.events.emit).toHaveBeenCalledOnce();
		expect(pi.events.emit).toHaveBeenCalledWith(
			"pi:model-adapter/register",
			expect.objectContaining({ id: "gemini-acp" }),
		);
	});

	it("does not emit or subscribe when PI_GEMINI_ACP_OFFER_MODEL_ADAPTER=0", () => {
		process.env.PI_GEMINI_ACP_OFFER_MODEL_ADAPTER = "0";
		const pi = createMockRegistrar();
		registerModelAdapter(pi);
		expect(pi.events.emit).not.toHaveBeenCalled();
		expect(pi.events.on).not.toHaveBeenCalled();
	});

	it("returns without throwing when registrar lacks events", () => {
		const pi: ModelAdapterRegistrar = {};
		expect(() => registerModelAdapter(pi)).not.toThrow();
	});

	it("returns without throwing when registrar events lacks on", () => {
		const pi: ModelAdapterRegistrar = {
			events: { emit: vi.fn() } as unknown as ModelAdapterRegistrar["events"],
		};
		expect(() => registerModelAdapter(pi)).not.toThrow();
	});

	it("returns without throwing when registrar events lacks emit", () => {
		const pi: ModelAdapterRegistrar = {
			events: { on: vi.fn() } as unknown as ModelAdapterRegistrar["events"],
		};
		expect(() => registerModelAdapter(pi)).not.toThrow();
	});
});

describe("getModelAdapterStatus", () => {
	beforeEach(() => {
		delete process.env.PI_GEMINI_ACP_OFFER_MODEL_ADAPTER;
		resetModelAdapterEmitted();
	});

	it("reports offered=false when adapter has not been emitted", () => {
		const status = getModelAdapterStatus();
		expect(status.offered).toBe(false);
		expect(status.capabilities).toEqual(["summarize"]);
		expect(status.priority).toBe(50);
	});

	it("reports offered=true after registerModelAdapter has emitted", () => {
		const pi = createMockRegistrar();
		registerModelAdapter(pi);
		const status = getModelAdapterStatus();
		expect(status.offered).toBe(true);
	});

	it("reports offered=false when registerModelAdapter is blocked by env=0", () => {
		process.env.PI_GEMINI_ACP_OFFER_MODEL_ADAPTER = "0";
		const pi = createMockRegistrar();
		registerModelAdapter(pi);
		const status = getModelAdapterStatus();
		expect(status.offered).toBe(false);
	});
});
