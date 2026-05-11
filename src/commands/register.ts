import type {
	GeminiCommand,
	PiCommandContext,
	PiCommandHandler,
	PiCommandRegistrar,
} from "./define.ts";
import { geminiConfigCommand } from "./gemini-config.ts";
import { geminiModelCommand } from "./gemini-model.ts";

/** Slash commands exposed by the Gemini ACP Pi extension. */
export const geminiAcpCommands = [geminiConfigCommand, geminiModelCommand] as const;

/** Registers Gemini ACP slash commands with a Pi host. */
export function registerGeminiAcpCommands(pi: PiCommandRegistrar): void {
	for (const command of geminiAcpCommands) {
		pi.registerCommand(command.name, {
			description: command.description,
			getArgumentCompletions: command.getArgumentCompletions,
			handler: buildCommandHandler(command),
		});
	}
}

/** Adapts a typed Gemini command (schema + execute) to the host's `(args, ctx)` handler. */
export function buildCommandHandler(command: GeminiCommand): PiCommandHandler {
	return async (args, ctx) => {
		try {
			const params = parseCommandArgs(command, args);
			const result = await command.execute(params, ctx);
			emitResult(ctx, result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emit(ctx, `/${command.name} failed: ${message}`, "error");
		}
	};
}

function parseCommandArgs(command: GeminiCommand, args: string): unknown {
	if (command.parseArgs) return command.parseArgs(args);
	const trimmed = args.trim();
	if (trimmed === "") return {};
	if (trimmed.startsWith("{")) return JSON.parse(trimmed);
	const firstKey = firstSchemaKey(command);
	if (!firstKey) {
		throw new Error(`Command /${command.name} expects no arguments or a JSON object.`);
	}
	return { [firstKey]: trimmed };
}

function firstSchemaKey(command: GeminiCommand): string | undefined {
	const properties = (command.parameters as { properties?: unknown }).properties;
	if (!properties || typeof properties !== "object") return undefined;
	const keys = Object.keys(properties as Record<string, unknown>);
	return keys[0];
}

function emitResult(
	ctx: PiCommandContext,
	result: { content?: Array<{ text?: string }>; details?: unknown },
): void {
	const text = result?.content?.[0]?.text;
	const errorCode = (result?.details as { error?: { code?: string } })?.error?.code;
	const type: "info" | "error" = errorCode ? "error" : "info";
	if (text) emit(ctx, text, type);
}

function emit(ctx: PiCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx?.hasUI && ctx.ui?.notify) {
		ctx.ui.notify(message, type);
		return;
	}
	const stream = type === "error" ? process.stderr : process.stdout;
	stream.write(`${message}\n`);
}
