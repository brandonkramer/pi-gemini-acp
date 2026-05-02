import { Type } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { errorResult, providerError, toolResult } from "../../tools/result.js";
import type { GeminiCommand, PiCommandContext } from "../define.js";
import { buildCommandHandler } from "../register.js";

function makeCommand(overrides: Partial<GeminiCommand> = {}): {
	command: GeminiCommand;
	execute: ReturnType<typeof vi.fn>;
} {
	const execute = vi.fn(async (_params: unknown) =>
		toolResult({ text: "ok", data: { ok: true } }),
	);
	const command: GeminiCommand = {
		name: "gemini-test",
		description: "test command",
		parameters: Type.Object({
			model: Type.Optional(Type.String()),
		}),
		execute,
		...overrides,
	} as GeminiCommand;
	return { command, execute };
}

function makeCtx(): {
	ctx: PiCommandContext;
	notify: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	return { ctx: { hasUI: true, ui: { notify } }, notify };
}

describe("buildCommandHandler", () => {
	it("passes empty params object when args string is empty", async () => {
		const { command, execute } = makeCommand();
		const { ctx, notify } = makeCtx();

		await buildCommandHandler(command)("", ctx);

		expect(execute).toHaveBeenCalledWith({}, undefined);
		expect(notify).toHaveBeenCalledWith("ok", "info");
	});

	it("assigns a bare string to the schema's first property", async () => {
		const { command, execute } = makeCommand();
		const { ctx } = makeCtx();

		await buildCommandHandler(command)("gemini-2.5-pro", ctx);

		expect(execute).toHaveBeenCalledWith(
			{ model: "gemini-2.5-pro" },
			undefined,
		);
	});

	it("parses JSON args into the params object", async () => {
		const { command, execute } = makeCommand();
		const { ctx } = makeCtx();

		await buildCommandHandler(command)('{"model":"gemini-flash"}', ctx);

		expect(execute).toHaveBeenCalledWith({ model: "gemini-flash" }, undefined);
	});

	it("surfaces an error notification when execute throws and does not reject", async () => {
		const { command } = makeCommand({
			execute: () => {
				throw new Error("boom");
			},
		});
		const { ctx, notify } = makeCtx();

		await expect(
			buildCommandHandler(command)("", ctx),
		).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledWith("/gemini-test failed: boom", "error");
	});

	it("surfaces an error notification when the result envelope carries an error code", async () => {
		const { command } = makeCommand({
			execute: async () =>
				errorResult(
					providerError(
						"GEMINI_ACP_PERMISSION_CONFIRMATION_REQUIRED",
						"permission_policy",
						"needs confirmation",
					),
					"policy refused",
				),
		});
		const { ctx, notify } = makeCtx();

		await buildCommandHandler(command)("", ctx);

		expect(notify).toHaveBeenCalledWith("policy refused", "error");
	});
});
