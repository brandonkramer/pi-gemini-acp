import type { ChildProcessWithoutNullStreams } from "node:child_process";

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
	formatInvalidJsonError?: (
		line: string,
		cause: unknown,
		stderrText: string,
	) => Error;
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
	private nextId = 1;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private closed = false;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly handlers: JsonRpcStdioHandlers;

	constructor(
		child: ChildProcessWithoutNullStreams,
		handlers: JsonRpcStdioHandlers = {},
	) {
		this.child = child;
		this.handlers = handlers;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
		child.stderr.on("data", (chunk: string) => {
			this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
		});
		child.on("error", (error) => this.rejectAll(error));
		child.on("exit", (code, signal) => {
			if (this.pending.size === 0) return;
			this.rejectAll(
				new Error(
					`JSON-RPC stdio process exited with ${signal ?? code ?? "unknown status"}: ${this.stderrBuffer}`,
				),
			);
		});
	}

	/** Recent stderr text retained for diagnostics. */
	get stderrText(): string {
		return this.stderrBuffer;
	}

	/** Sends a JSON-RPC request and resolves with the response result. */
	request<T = unknown>(
		method: string,
		params?: unknown,
		options: JsonRpcRequestOptions<T> = {},
	): Promise<T> {
		if (options.signal?.aborted) {
			options.onAbort?.();
			return options.abortMode === "resolve"
				? Promise.resolve(options.abortValue as T)
				: Promise.reject(abortError());
		}
		const id = this.nextId++;
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
				timeout = setTimeout(() => {
					this.pending.delete(id);
					cleanup();
					reject(new Error(`Timed out after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
			}
			options.signal?.addEventListener("abort", abort, { once: true });
		});
		this.write({ jsonrpc: "2.0", id, method, params });
		return promise;
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

	/** Closes stdio, terminates the child, and rejects pending requests. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.rejectAll(new Error("JSON-RPC stdio client closed"));
		try {
			this.child.stdin.end();
		} catch {
			/* The subprocess may already have closed stdio after failure/abort. */
		}
		if (!this.child.killed) this.child.kill("SIGTERM");
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
		try {
			void this.handleMessage(JSON.parse(line) as JsonRpcMessage).catch(
				(cause: unknown) => this.rejectAll(errorFromCause(cause)),
			);
		} catch (cause) {
			this.rejectAll(this.invalidJsonError(line, cause));
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
			pending.reject(new Error(message.error.message));
		} else {
			pending.resolve(message.result);
		}
	}

	private async handleIncomingRequest(message: JsonRpcRequest): Promise<void> {
		try {
			const result = await this.handlers.onRequest?.(message);
			this.respond(message.id, result);
		} catch (cause) {
			this.respondError(message.id, errorObject(cause));
		}
	}

	private invalidJsonError(line: string, cause: unknown): Error {
		return (
			this.handlers.formatInvalidJsonError?.(line, cause, this.stderrBuffer) ??
			new Error(
				`JSON-RPC stdio emitted non-JSON stdout: ${line.slice(0, 240)}`,
				{ cause },
			)
		);
	}

	private write(message: JsonRpcMessage): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
