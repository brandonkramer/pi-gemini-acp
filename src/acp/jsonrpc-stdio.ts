import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { traceAcp, type TraceFields } from "./trace.ts";

let nextConnectionId = 1;

/** A failed transport cannot be reused, even if no request was pending at failure time. */
export class JsonRpcTransportError extends Error {}

export class JsonRpcTimeoutError extends JsonRpcTransportError {}

/** JSON-RPC request/response identifier accepted by the stdio transport. */
export type JsonRpcId = number | string;

/** JSON-RPC error object transported over stdio. */
export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

/** Parsed JSON-RPC message shape used by the stdio transport. */
export interface JsonRpcMessage {
	jsonrpc?: "2.0";
	id?: JsonRpcId;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: JsonRpcErrorObject;
}

/** Incoming JSON-RPC request with a required method and id. */
export interface JsonRpcRequest extends JsonRpcMessage {
	id: JsonRpcId;
	method: string;
}

/** Incoming JSON-RPC notification with a required method and no id. */
export interface JsonRpcNotification extends JsonRpcMessage {
	method: string;
}

/** Hooks for protocol-specific request and notification handling. */
export interface JsonRpcStdioHandlers {
	onRequest?: (message: JsonRpcRequest) => Promise<unknown> | unknown;
	onNotification?: (message: JsonRpcNotification) => Promise<void> | void;
	formatInvalidJsonError?: (line: string, cause: unknown, stderrText: string) => Error;
}

/** Options for one outgoing JSON-RPC request. */
export interface JsonRpcRequestOptions<T> {
	signal?: AbortSignal;
	timeoutMs?: number;
	onAbort?: () => void;
	abortMode?: "reject" | "resolve";
	abortValue?: T;
}

interface PendingRequest<T = unknown> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

/** Error type thrown by request handlers to send a JSON-RPC error response. */
export class JsonRpcResponseError extends Error {
	/** JSON-RPC error code. */
	readonly code: number;
	/** Optional JSON-RPC error data payload. */
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "JsonRpcResponseError";
		this.code = code;
		this.data = data;
	}
}

/** Shared JSON-RPC-over-stdio client for Gemini ACP subprocesses. */
export class JsonRpcStdioClient {
	readonly connectionId = nextConnectionId++;
	private nextId = 1;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private closed = false;
	private failure?: Error;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly handlers: JsonRpcStdioHandlers;

	constructor(child: ChildProcessWithoutNullStreams, handlers: JsonRpcStdioHandlers = {}) {
		this.child = child;
		this.handlers = handlers;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
		child.stderr.on("data", (chunk: string) => {
			this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
		});
		child.on("error", (error) =>
			this.fail(new JsonRpcTransportError(error.message, { cause: error })),
		);
		child.stdin.on("error", (error) =>
			this.fail(new JsonRpcTransportError(error.message, { cause: error })),
		);
		child.on("exit", (code, signal) => {
			this.fail(
				new JsonRpcTransportError(
					`JSON-RPC stdio process exited with ${signal ?? code ?? "unknown status"}: ${this.stderrBuffer}`,
				),
			);
		});
	}

	/** Recent stderr text retained for diagnostics. */
	get stderrText(): string {
		return this.stderrBuffer;
	}

	/** The child process pid for process-group kill escalation. */
	get pid(): number | undefined {
		return this.child.pid;
	}

	/** Sends a JSON-RPC request and resolves with the response result. */
	request<T = unknown>(
		method: string,
		params?: unknown,
		options: JsonRpcRequestOptions<T> = {},
	): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed)
			return Promise.reject(new JsonRpcTransportError("JSON-RPC stdio client closed"));
		if (options.signal?.aborted) {
			return options.abortMode === "resolve"
				? Promise.resolve(options.abortValue as T)
				: Promise.reject(abortError());
		}
		const id = this.nextId++;
		const started = performance.now();
		this.trace("rpc.start", { method, requestId: id });
		let timeout: NodeJS.Timeout | undefined;
		let abort: (() => void) | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			if (abort) options.signal?.removeEventListener("abort", abort);
		};
		const promise = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, cleanup } as PendingRequest);
			abort = () => {
				this.pending.delete(id);
				cleanup();
				options.onAbort?.();
				if (options.abortMode === "resolve") {
					resolve(options.abortValue as T);
				} else {
					reject(abortError());
				}
			};
			if (options.timeoutMs) {
				const timeoutMs = options.timeoutMs;
				timeout = setTimeout(() => {
					this.pending.delete(id);
					cleanup();
					options.onAbort?.();
					const error = new JsonRpcTimeoutError(
						`Gemini ACP ${method} timed out after ${timeoutMs}ms. The connection will not be reused; check ACP diagnostics before retrying actions that may have completed.`,
					);
					this.fail(error);
					reject(error);
				}, timeoutMs);
			}
			options.signal?.addEventListener("abort", abort, { once: true });
		});
		this.write({ jsonrpc: "2.0", id, method, params });
		return promise.then(
			(value) => {
				this.trace("rpc.end", {
					method,
					requestId: id,
					durationMs: performance.now() - started,
					outcome: options.signal?.aborted ? "aborted" : "ok",
				});
				return value;
			},
			(error: unknown) => {
				this.trace("rpc.end", {
					method,
					requestId: id,
					durationMs: performance.now() - started,
					outcome:
						error instanceof JsonRpcTimeoutError
							? "timeout"
							: options.signal?.aborted
								? "aborted"
								: "error",
					code: error instanceof JsonRpcResponseError ? error.code : undefined,
				});
				throw error;
			},
		);
	}

	/** Sends a JSON-RPC notification without waiting for a response. */
	notify(method: string, params?: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	/** Sends a JSON-RPC success response for an incoming request. */
	respond(id: JsonRpcId | undefined, result?: unknown): void {
		if (id === undefined) return;
		this.write({ jsonrpc: "2.0", id, result });
	}

	/** Sends a JSON-RPC error response for an incoming request. */
	respondError(id: JsonRpcId | undefined, error: JsonRpcErrorObject): void {
		if (id === undefined) return;
		this.write({ jsonrpc: "2.0", id, error });
	}

	/** Closes stdio, terminates the child (and descendants), and rejects pending requests. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.fail(new JsonRpcTransportError("JSON-RPC stdio client closed"));
		try {
			this.child.stdin.end();
		} catch {
			/* The subprocess may already have closed stdio after failure/abort. */
		}
		const stillAlive = (): boolean =>
			(this.child.exitCode ?? null) === null && (this.child.signalCode ?? null) === null;
		if (stillAlive()) {
			this.killProcessGroup("SIGTERM");
			// Escalate to SIGKILL after a grace period so the Gemini CLI wrapper's own Node child
			// (--max-old-space-size=8192) is reliably terminated.
			const pid = this.child.pid;
			if (pid) {
				const timer = setTimeout(() => {
					if (stillAlive()) this.killProcessGroup("SIGKILL");
				}, 3_000);
				timer.unref();
				// Clear the escalation timer if the child exits before it fires.
				this.child.once("exit", () => clearTimeout(timer));
			}
		}
	}

	/**
	 * Sends a signal to the entire process group (child + grandchildren). On Windows
	 * process.kill(-pid) throws, so it falls back to child.kill() which may orphan grandchildren — a
	 * pre-existing platform limitation, not a regression.
	 */
	private killProcessGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid) {
			try {
				process.kill(-pid, signal);
				return;
			} catch {
				/* Process group may already be gone; fall through to direct child kill. */
			}
		}
		this.child.kill(signal);
	}

	private trace(event: string, fields: TraceFields): void {
		traceAcp(event, { ...fields, connectionId: this.connectionId });
	}

	private fail(error: Error): void {
		if (!this.failure)
			this.trace(this.closed ? "transport.closed" : "transport.failed", {
				outcome: this.closed ? "ok" : "error",
			});
		this.failure ??= error;
		this.rejectAll(this.failure);
	}

	/** Rejects all pending requests with the supplied error. */
	rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
	}

	private readStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line) this.handleStdoutLine(line);
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	private handleStdoutLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
			return;
		}
		try {
			void this.handleMessage(JSON.parse(trimmed) as JsonRpcMessage).catch((cause: unknown) =>
				this.fail(new JsonRpcTransportError(errorFromCause(cause).message, { cause })),
			);
		} catch (cause) {
			this.fail(new JsonRpcTransportError(this.invalidJsonError(line, cause).message, { cause }));
		}
	}

	private async handleMessage(message: JsonRpcMessage): Promise<void> {
		if (message.id !== undefined && message.method) {
			await this.handleIncomingRequest(message as JsonRpcRequest);
			return;
		}
		if (message.id !== undefined) {
			this.handleResponse(message);
			return;
		}
		if (message.method) {
			await this.handlers.onNotification?.(message as JsonRpcNotification);
		}
	}

	private handleResponse(message: JsonRpcMessage): void {
		const pending = this.pending.get(message.id as JsonRpcId);
		if (!pending) return;
		this.pending.delete(message.id as JsonRpcId);
		pending.cleanup();
		if (message.error) {
			pending.reject(
				new JsonRpcResponseError(message.error.code, message.error.message, message.error.data),
			);
		} else {
			pending.resolve(message.result);
		}
	}

	private async handleIncomingRequest(message: JsonRpcRequest): Promise<void> {
		const started = performance.now();
		this.trace("rpc.incoming", { method: message.method });
		try {
			const result = await this.handlers.onRequest?.(message);
			this.respond(message.id, result);
			this.trace("rpc.incoming.end", {
				method: message.method,
				durationMs: performance.now() - started,
				outcome: "ok",
			});
		} catch (cause) {
			const error = errorObject(cause);
			this.respondError(message.id, error);
			this.trace("rpc.incoming.end", {
				method: message.method,
				durationMs: performance.now() - started,
				outcome: "error",
				code: error.code,
			});
		}
	}

	private invalidJsonError(line: string, cause: unknown): Error {
		return (
			this.handlers.formatInvalidJsonError?.(line, cause, this.stderrBuffer) ??
			new Error(`JSON-RPC stdio emitted non-JSON stdout: ${line.slice(0, 240)}`, { cause })
		);
	}

	private write(message: JsonRpcMessage): void {
		if (this.closed || this.failure) return;
		try {
			this.child.stdin.write(`${JSON.stringify(message)}\n`);
		} catch (cause) {
			this.fail(new JsonRpcTransportError("Failed to write to Gemini ACP", { cause }));
		}
	}
}

function errorObject(cause: unknown): JsonRpcErrorObject {
	if (cause instanceof JsonRpcResponseError) {
		return { code: cause.code, message: cause.message, data: cause.data };
	}
	return {
		code: -32603,
		message: cause instanceof Error ? cause.message : "JSON-RPC request failed",
	};
}

function errorFromCause(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error("JSON-RPC handler failed");
}

function abortError(): Error {
	return new DOMException("JSON-RPC request aborted", "AbortError");
}
