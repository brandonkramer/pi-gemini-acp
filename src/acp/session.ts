import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
	resolveGeminiAcpCommand,
	spawnCommandForGeminiAcpResolution,
} from "../config/command.js";
import {
	permissionPolicyCapabilities,
	requirePermissionCapability,
} from "../config/permission-policy.js";
import type { GeminiAcpPermissionPolicy } from "../types.js";
import type {
	GeminiAcpCommandSettings,
	GeminiAcpPromptPart,
	GeminiAcpPromptUpdateHandler,
} from "./client.js";

interface JsonRpcMessage {
	jsonrpc?: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

const MAX_CLIENT_READ_BYTES = 1_000_000;

/** Normalized subset of ACP initialize capabilities used for feature preflight. */
export interface GeminiAcpInitializeResult {
	promptCapabilities: {
		embeddedContext: boolean;
		image: boolean;
		audio: boolean;
	};
}

/** Minimal ACP process/session operations used by one-shot and cached clients. */
export interface GeminiAcpProcessSession {
	initialize(): Promise<GeminiAcpInitializeResult>;
	newSession(cwd: string): Promise<string>;
	prompt(
		sessionId: string,
		prompt: string | GeminiAcpPromptPart[],
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string>;
	close(): Promise<void>;
}

/** Factory used by production code and cache tests to create ACP sessions. */
export type GeminiAcpProcessSessionFactory = (
	settings: GeminiAcpCommandSettings,
	signal?: AbortSignal,
) => Promise<GeminiAcpProcessSession>;

/** JSON-RPC-over-stdio session for one Gemini ACP subprocess. */
export class AcpProcessSession implements GeminiAcpProcessSession {
	private nextId = 1;
	private readonly pending = new Map<number | string, PendingRequest>();
	private readonly agentText: string[] = [];
	private promptUpdateHandler?: GeminiAcpPromptUpdateHandler;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private closed = false;
	private sessionCwd = process.cwd();
	private readonly allowedReadPaths: Set<string>;

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly permissionPolicy?: GeminiAcpPermissionPolicy,
		allowedReadPaths: readonly string[] = [],
	) {
		this.allowedReadPaths = new Set(
			allowedReadPaths.map((filePath) => path.resolve(filePath)),
		);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
		child.stderr.on("data", (chunk: string) => {
			this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
		});
		child.on("error", (error) => this.rejectAll(error));
		child.on("exit", (code, signal) =>
			this.rejectAll(
				new Error(
					`Gemini ACP exited with ${signal ?? code ?? "unknown status"}: ${this.stderrBuffer}`,
				),
			),
		);
	}

	/** Starts a local Gemini ACP subprocess and binds cancellation to SIGTERM. */
	static async start(
		settings: GeminiAcpCommandSettings,
		signal?: AbortSignal,
	): Promise<AcpProcessSession> {
		const resolution = await resolveGeminiAcpCommand(settings.command);
		const command = spawnCommandForGeminiAcpResolution(
			resolution,
			settings.args ?? [],
		);
		const child = spawn(command.command, command.args, {
			stdio: "pipe",
			env: process.env,
		});
		const session = new AcpProcessSession(
			child,
			settings.permissionPolicy,
			settings.allowedReadPaths,
		);
		if (signal?.aborted) {
			child.kill("SIGTERM");
			throw abortError();
		}
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		child.once("exit", () => signal?.removeEventListener("abort", abort));
		return session;
	}

	async initialize(): Promise<GeminiAcpInitializeResult> {
		const result = await this.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "pi-gemini-acp", version: "0.1.0" },
			clientCapabilities: permissionPolicyCapabilities(this.permissionPolicy),
		});
		return normalizeInitializeResult(result);
	}

	async newSession(cwd: string): Promise<string> {
		this.sessionCwd = path.resolve(cwd);
		const result = await this.request("session/new", { cwd, mcpServers: [] });
		const sessionId = asRecord(result)?.sessionId;
		if (typeof sessionId !== "string") {
			throw new Error("Gemini ACP did not return a sessionId");
		}
		return sessionId;
	}

	async prompt(
		sessionId: string,
		prompt: string | GeminiAcpPromptPart[],
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		this.agentText.length = 0;
		this.promptUpdateHandler = onUpdate;
		try {
			await this.request("session/prompt", {
				sessionId,
				prompt:
					typeof prompt === "string"
						? [{ type: "text", text: prompt }]
						: prompt,
			});
			return this.agentText.join("").trim();
		} finally {
			this.promptUpdateHandler = undefined;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			this.child.stdin.end();
		} catch {
			/* The subprocess may already have closed stdio after failure/abort. */
		}
		if (!this.child.killed) this.child.kill("SIGTERM");
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const promise = new Promise<unknown>((resolve, reject) =>
			this.pending.set(id, { resolve, reject }),
		);
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return promise;
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
			this.handleMessage(JSON.parse(line) as JsonRpcMessage);
		} catch (cause) {
			// ACP requires stdout to be JSON-RPC only; provider diagnostics must fail
			// clearly because otherwise a local trust/auth warning can crash the stream.
			this.rejectAll(
				new Error(
					`Gemini ACP emitted non-JSON stdout before a JSON-RPC message. This often means the Gemini CLI printed a local workspace trust/auth warning; run /gemini-config trust or configure Gemini to keep diagnostics off stdout. First stdout line: ${line.slice(0, 240)}`,
					{ cause },
				),
			);
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (message.id !== undefined && message.method) {
			void this.handleAgentRequest(message);
			return;
		}
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(
					new Error(message.error.message ?? "Gemini ACP request failed"),
				);
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (message.method === "session/update") this.collectUpdate(message.params);
	}

	private async handleAgentRequest(message: JsonRpcMessage): Promise<void> {
		if (message.method === "session/request_permission") {
			const optionId = permissionOptionId(
				message.params,
				this.permissionPolicy,
			);
			this.respond(message.id, {
				outcome: optionId
					? { outcome: "selected", optionId }
					: { outcome: "cancelled" },
			});
			return;
		}
		if (message.method === "fs/read_text_file") {
			await this.handleReadTextFileRequest(message);
			return;
		}
		this.respond(message.id, undefined, {
			code: -32601,
			message: `Method not found: ${message.method}`,
		});
	}

	private async handleReadTextFileRequest(
		message: JsonRpcMessage,
	): Promise<void> {
		const requestedPath = stringValue(asRecord(message.params)?.path);
		const normalizedPath = requestedPath
			? normalizeRequestedFilePath(requestedPath)
			: undefined;
		const resolvedPath = normalizedPath
			? this.allowedReadPathForRequest(normalizedPath)
			: undefined;
		if (!resolvedPath) {
			this.respond(message.id, undefined, {
				code: -32000,
				message: "Gemini ACP file read was denied by the Pi allowlist.",
			});
			return;
		}
		try {
			const stat = await lstat(resolvedPath);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				this.respond(message.id, undefined, {
					code: -32000,
					message: "Gemini ACP file read was denied for a non-regular file.",
				});
				return;
			}
			if (stat.size > MAX_CLIENT_READ_BYTES) {
				this.respond(message.id, undefined, {
					code: -32000,
					message:
						"Gemini ACP file read was denied because the file is too large.",
				});
				return;
			}
			this.respond(message.id, {
				content: await readFile(resolvedPath, "utf8"),
			});
		} catch (cause) {
			this.respond(message.id, undefined, {
				code: -32000,
				message:
					cause instanceof Error
						? cause.message
						: "Gemini ACP file read failed.",
			});
		}
	}

	private allowedReadPathForRequest(requestedPath: string): string | undefined {
		const candidates = path.isAbsolute(requestedPath)
			? [path.resolve(requestedPath)]
			: [
					path.resolve(this.sessionCwd, requestedPath),
					path.resolve(requestedPath),
				];
		return candidates.find((candidate) => this.allowedReadPaths.has(candidate));
	}

	private respond(
		id: number | string | undefined,
		result?: unknown,
		error?: JsonRpcMessage["error"],
	): void {
		if (id === undefined) return;
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`,
		);
	}

	private collectUpdate(params: unknown): void {
		const update = asRecord(asRecord(params)?.update);
		if (update?.sessionUpdate !== "agent_message_chunk") return;
		const content = asRecord(update.content);
		if (content?.type === "text" && typeof content.text === "string") {
			this.agentText.push(content.text);
			this.emitPromptUpdate(content.text);
		}
	}

	private emitPromptUpdate(text: string): void {
		const onUpdate = this.promptUpdateHandler;
		if (!onUpdate) return;
		void Promise.resolve(
			onUpdate({
				type: "chunk",
				text,
				accumulatedText: this.agentText.join(""),
			}),
		).catch(() => {
			/* Streaming callbacks must not destabilize the ACP session. */
		});
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

/** Resolves the ACP permission option allowed by the configured Pi policy. */
export function permissionOptionId(
	params: unknown,
	policy?: GeminiAcpPermissionPolicy,
): string | undefined {
	const capability = permissionCapabilityForRequest(params);
	if (!capability || requirePermissionCapability(policy, capability)) {
		return undefined;
	}
	const options = asRecord(params)?.options;
	if (!Array.isArray(options)) return undefined;
	return options.find((option) => asRecord(option)?.kind === "allow_once")
		?.optionId as string | undefined;
}

function permissionCapabilityForRequest(
	params: unknown,
): "filesystemRead" | "filesystemWrite" | "terminal" | undefined {
	const text = JSON.stringify(params)?.toLowerCase() ?? "";
	if (/(^|[^a-z])(terminal|shell|command|execute|exec)([^a-z]|$)/u.test(text)) {
		return "terminal";
	}
	if (
		/(^|[^a-z])(write|modify|delete|create|overwrite|edit)([^a-z]|$)/u.test(
			text,
		)
	) {
		return "filesystemWrite";
	}
	if (/(^|[^a-z])(file|path|read|open|workspace)([^a-z]|$)/u.test(text)) {
		return "filesystemRead";
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizeInitializeResult(result: unknown): GeminiAcpInitializeResult {
	const capabilities = asRecord(asRecord(result)?.agentCapabilities);
	const promptCapabilities = asRecord(capabilities?.promptCapabilities);
	return {
		promptCapabilities: {
			embeddedContext: promptCapabilities?.embeddedContext === true,
			image: promptCapabilities?.image === true,
			audio: promptCapabilities?.audio === true,
		},
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRequestedFilePath(value: string): string {
	if (!value.startsWith("file://")) return value;
	try {
		return decodeURI(value.slice("file://".length));
	} catch {
		return value.slice("file://".length);
	}
}

function abortError(): Error {
	return new DOMException("Gemini ACP request aborted", "AbortError");
}
