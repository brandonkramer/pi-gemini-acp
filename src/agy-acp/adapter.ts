/** @file ACP stdio adapter for Antigravity CLI (agy). */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

interface JsonRpcMessage {
	jsonrpc?: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface AgyAcpAdapterOptions {
	agyCommand: string;
	agyArgs: string[];
	sandbox?: boolean;
	stdin?: Readable;
	stdout?: Writable;
}

interface AgyAcpAdapter {
	start(): void;
}

/** Creates an ACP stdio adapter that bridges to agy -p. */
export function createAgyAcpAdapter(options: AgyAcpAdapterOptions): AgyAcpAdapter {
	let buffer = "";
	let closed = false;
	const input = options.stdin ?? process.stdin;
	const output = options.stdout ?? process.stdout;

	function write(message: JsonRpcMessage): void {
		if (closed) return;
		output.write(`${JSON.stringify(message)}\n`);
	}

	function respondError(id: number | string | undefined, code: number, message: string): void {
		if (id === undefined) return;
		write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	function respond(id: number | string | undefined, result: unknown): void {
		if (id === undefined) return;
		write({ jsonrpc: "2.0", id, result });
	}

	async function handleInitialize(id: number | string | undefined): Promise<void> {
		respond(id, {
			protocolVersion: 1,
			agentInfo: { name: "agy-acp", version: "0.1.0" },
			agentCapabilities: {
				promptCapabilities: {
					embeddedContext: false,
					image: false,
					audio: false,
				},
			},
		});
	}

	async function handleNewSession(id: number | string | undefined): Promise<void> {
		// agy is stateless; return a stable dummy session id.
		respond(id, { sessionId: "agy-session" });
	}

	async function handlePrompt(id: number | string | undefined, params: unknown): Promise<void> {
		const record = asRecord(params);
		const prompt = extractPromptText(record?.prompt);
		if (!prompt) {
			respondError(id, -32602, "Missing or invalid prompt parameter");
			return;
		}

		const args = [...options.agyArgs];
		if (options.sandbox) args.push("--sandbox");
		args.push("-p", prompt);

		try {
			const result = await runAgy(options.agyCommand, args);
			respond(id, result);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : "agy prompt failed";
			respondError(id, -32603, message);
		}
	}

	async function handleRequest(message: JsonRpcMessage): Promise<void> {
		const { id, method, params } = message;
		if (!method) {
			respondError(id, -32601, "Method not found: undefined");
			return;
		}
		switch (method) {
			case "initialize":
				await handleInitialize(id);
				break;
			case "session/new":
				await handleNewSession(id);
				break;
			case "session/prompt":
				await handlePrompt(id, params);
				break;
			default:
				respondError(id, -32601, `Method not found: ${method}`);
				break;
		}
	}

	async function handleMessage(message: JsonRpcMessage): Promise<void> {
		if (message.id !== undefined && message.method) {
			await handleRequest(message);
		}
		// Ignore responses and notifications (agy adapter is server-only)
	}

	function readChunk(chunk: string): void {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) void handleLine(line);
			newline = buffer.indexOf("\n");
		}
	}

	async function handleLine(line: string): Promise<void> {
		const trimmed = line.trim();
		if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
			return;
		}
		try {
			await handleMessage(JSON.parse(trimmed) as JsonRpcMessage);
		} catch {
			// Non-JSON lines are ignored per ACP spec
		}
	}

	return {
		start(): void {
			input.setEncoding("utf8");
			input.on("data", (chunk: string) => readChunk(chunk));
			input.on("end", () => {
				closed = true;
			});
		},
	};
}

/** Runs agy with the given args and returns trimmed stdout. */
function runAgy(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		let timeout: NodeJS.Timeout | undefined;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code === 0 || signal === "SIGTERM") {
				resolve(stdout.trim());
				return;
			}
			reject(
				new Error(
					`agy exited with ${signal ?? code ?? "unknown"}${stderr ? `: ${stderr.slice(0, 400)}` : ""}`,
				),
			);
		});
		// Default timeout: 5 minutes (agy -p default is 5m)
		timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("agy prompt timed out after 300000ms"));
		}, 300_000);
	});
}

/** Extracts plain text from ACP prompt parts or a string. */
function extractPromptText(prompt: unknown): string | undefined {
	if (typeof prompt === "string") return prompt;
	if (Array.isArray(prompt)) {
		return prompt
			.map((part) => {
				const record = asRecord(part);
				if (record?.type === "text" && typeof record.text === "string") {
					return record.text;
				}
				return "";
			})
			.join("");
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
