import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { setupShutdownHooks, type ShutdownProcess } from "../index.ts";

function fakeProcess() {
	const emitter = new EventEmitter();
	const kill = vi.fn();
	const proc = {
		pid: 4242,
		on: (signal, handler) => emitter.on(signal, handler),
		off: (signal, handler) => emitter.off(signal, handler),
		listenerCount: (signal) => emitter.listenerCount(signal),
		kill,
	} satisfies ShutdownProcess;
	return { emitter, proc, kill };
}

const flush = () =>
	new Promise((resolve) => {
		setImmediate(resolve);
	});

describe("setupShutdownHooks", () => {
	it("re-raises the signal after cleanup when it is the only listener", async () => {
		const { emitter, proc, kill } = fakeProcess();
		const close = vi.fn(async () => undefined);
		setupShutdownHooks(proc, close);
		emitter.emit("SIGTERM", "SIGTERM");
		await flush();
		expect(close).toHaveBeenCalledTimes(1);
		expect(emitter.listenerCount("SIGTERM")).toBe(0);
		expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
	});

	it("re-raises even when cleanup fails", async () => {
		const { emitter, proc, kill } = fakeProcess();
		setupShutdownHooks(proc, async () => {
			throw new Error("cleanup failed");
		});
		emitter.emit("SIGHUP", "SIGHUP");
		await flush();
		expect(kill).toHaveBeenCalledWith(4242, "SIGHUP");
	});

	it("leaves the signal to another listener, such as Pi's SIGINT handler", async () => {
		const { emitter, proc, kill } = fakeProcess();
		const piHandler = vi.fn();
		emitter.on("SIGINT", piHandler);
		const close = vi.fn(async () => undefined);
		const dispose = setupShutdownHooks(proc, close);
		emitter.emit("SIGINT", "SIGINT");
		await flush();
		expect(close).toHaveBeenCalledTimes(1);
		expect(kill).not.toHaveBeenCalled();
		expect(piHandler).toHaveBeenCalledTimes(1);
		// The process kept running, so a later signal cleans up again.
		emitter.emit("SIGINT", "SIGINT");
		await flush();
		expect(close).toHaveBeenCalledTimes(2);
		dispose();
		expect(emitter.listenerCount("SIGINT")).toBe(1);
	});
});
