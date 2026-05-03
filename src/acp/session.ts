import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	permissionPolicyCapabilities,
	requirePermissionCapability,
} from "../config/permission-policy.js";
import type { GeminiAcpPermissionPolicy } from "../types.js";
import type {
	GeminiAcpCommandSettings,
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

/** Minimal ACP process/session operations used by one-shot and cached clients. */
export interface GeminiAcpProcessSession {
	initialize(): Promise<void>;
	newSession(cwd: string): Promise<string>;
	prompt(
		sessionId: string,
		text: string,
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

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly permissionPolicy?: GeminiAcpPermissionPolicy,
	) {
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
		const child = spawn(settings.command, settings.args ?? [], {
			stdio: "pipe",
			env: process.env,
		});
		const session = new AcpProcessSession(child, settings.permissionPolicy);
		if (signal?.aborted) {
			child.kill("SIGTERM");
			throw abortError();
		}
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		child.once("exit", () => signal?.removeEventListener("abort", abort));
		return session;
	}

	async initialize(): Promise<void> {
		await this.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "pi-gemini-acp", version: "0.1.0" },
			clientCapabilities: permissionPolicyCapabilities(this.permissionPolicy),
		});
	}

	async newSession(cwd: string): Promise<string> {
		const result = await this.request("session/new", { cwd, mcpServers: [] });
		const sessionId = asRecord(result)?.sessionId;
		if (typeof sessionId !== "string") {
			throw new Error("Gemini ACP did not return a sessionId");
		}
		return sessionId;
	}

	async prompt(
		sessionId: string,
		text: string,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		this.agentText.length = 0;
		this.promptUpdateHandler = onUpdate;
		try {
			await this.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text }],
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
			if (line) this.handleMessage(JSON.parse(line) as JsonRpcMessage);
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (message.id !== undefined && message.method) {
			this.handleAgentRequest(message);
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

	private handleAgentRequest(message: JsonRpcMessage): void {
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
		this.respond(message.id, undefined, {
			code: -32601,
			message: `Method not found: ${message.method}`,
		});
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

function abortError(): Error {
	return new DOMException("Gemini ACP request aborted", "AbortError");
}
