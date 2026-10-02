import { type ChildProcessWithoutNullStreams, spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { resolveGeminiAcpCommand, spawnCommandForGeminiAcpResolution } from "../config/command.ts";
import { resolveGitIdentityEnv } from "../config/git-identity.ts";
import {
	permissionPolicyCapabilities,
	requirePermissionCapability,
} from "../config/permission-policy.ts";
import type { GeminiAcpPermissionPolicy } from "../types.ts";
import { coerceString } from "../utils/coerce.ts";
import type {
	GeminiAcpCommandSettings,
	GeminiAcpPromptPart,
	GeminiAcpPromptUpdateHandler,
} from "./client.ts";
import {
	JsonRpcResponseError,
	JsonRpcStdioClient,
	type JsonRpcNotification,
	type JsonRpcRequest,
} from "./jsonrpc-stdio.ts";
import { acpTimeoutMs, traceAcp } from "./trace.ts";

/**
 * Total deadline for one ACP prompt. A turn can run many Gemini tool calls (edits, builds, tests),
 * and a timeout discards its answer, so this only guards against a peer that never responds.
 */
export const DEFAULT_PROMPT_TIMEOUT_MS = 1_800_000;

/** Controls cancellation behavior for one in-flight ACP prompt turn. */
export interface GeminiAcpPromptOptions {
	signal?: AbortSignal;
	returnTextOnAbort?: boolean;
}

const MAX_CLIENT_READ_BYTES = 1_000_000;

interface PromptState {
	accumulatedText: string;
	onUpdate?: GeminiAcpPromptUpdateHandler;
}

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
	initialize(signal?: AbortSignal): Promise<GeminiAcpInitializeResult>;
	newSession(cwd: string, signal?: AbortSignal): Promise<string>;
	prompt(
		sessionId: string,
		prompt: string | GeminiAcpPromptPart[],
		onUpdate?: GeminiAcpPromptUpdateHandler,
		options?: GeminiAcpPromptOptions,
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
	private readonly rpc: JsonRpcStdioClient;
	private readonly promptStates = new Map<string, PromptState>();
	private sessionCwd = process.cwd();
	private readonly allowedReadPaths: Set<string>;

	private readonly permissionPolicy?: GeminiAcpPermissionPolicy;

	private constructor(
		child: ChildProcessWithoutNullStreams,
		permissionPolicy?: GeminiAcpPermissionPolicy,
		allowedReadPaths: readonly string[] = [],
	) {
		this.permissionPolicy = permissionPolicy;
		this.allowedReadPaths = new Set(allowedReadPaths.map((filePath) => path.resolve(filePath)));
		this.rpc = new JsonRpcStdioClient(child, {
			onRequest: (message) => this.handleAgentRequest(message),
			onNotification: (message) => this.handleNotification(message),
			formatInvalidJsonError: (line, cause) =>
				new Error(
					`Gemini ACP emitted non-JSON stdout before a JSON-RPC message. This often means the Gemini CLI printed a local workspace trust/auth warning; run /gemini-config trust or configure Gemini to keep diagnostics off stdout. First stdout line: ${line.slice(0, 240)}`,
					{ cause },
				),
		});
	}

	/** Starts a local Gemini ACP subprocess and binds cancellation to SIGTERM. */
	static async start(
		settings: GeminiAcpCommandSettings,
		signal?: AbortSignal,
	): Promise<AcpProcessSession> {
		const resolution = await resolveGeminiAcpCommand(settings.command);
		const command = spawnCommandForGeminiAcpResolution(resolution, settings.args ?? []);
		// Inject the user's git identity: Gemini's sandboxed shell strips all
		// GIT_CONFIG_* variables (and points GIT_CONFIG_GLOBAL at /dev/null), so
		// in-sandbox `git commit` would otherwise fail with an unknown identity.
		// The env is fixed at spawn and the process may serve several ACP
		// sessions, so resolve it for Pi's working directory (process.cwd()).
		const gitIdentityEnv = resolveGitIdentityEnv();
		const child = spawn(command.command, command.args, {
			stdio: "pipe",
			env: settings.env
				? { ...process.env, ...gitIdentityEnv, ...settings.env }
				: { ...process.env, ...gitIdentityEnv },
			windowsVerbatimArguments: command.windowsVerbatimArguments,
			detached: true,
			windowsHide: true,
		});
		const session = new AcpProcessSession(
			child,
			settings.permissionPolicy,
			settings.allowedReadPaths,
		);
		if (signal?.aborted) {
			killProcessGroup(child);
			throw abortError();
		}
		const abort = () => {
			killProcessGroup(child);
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.once("exit", () => {
			signal?.removeEventListener("abort", abort);
		});
		return session;
	}

	async initialize(signal?: AbortSignal): Promise<GeminiAcpInitializeResult> {
		const result = await this.rpc.request(
			"initialize",
			{
				protocolVersion: 1,
				clientInfo: { name: "pi-gemini-acp", version: "0.1.0" },
				clientCapabilities: permissionPolicyCapabilities(this.permissionPolicy, {
					servesFileReads: this.allowedReadPaths.size > 0,
				}),
			},
			{ signal, timeoutMs: acpTimeoutMs("PI_GEMINI_ACP_STARTUP_TIMEOUT_MS", 60_000) },
		);
		return normalizeInitializeResult(result);
	}

	async newSession(cwd: string, signal?: AbortSignal): Promise<string> {
		this.sessionCwd = path.resolve(cwd);
		const result = await this.rpc.request(
			"session/new",
			{
				cwd,
				mcpServers: [],
			},
			{ signal, timeoutMs: acpTimeoutMs("PI_GEMINI_ACP_STARTUP_TIMEOUT_MS", 60_000) },
		);
		const sessionId = asRecord(result)?.sessionId;
		if (typeof sessionId !== "string") {
			throw new TypeError("Gemini ACP did not return a sessionId");
		}
		return sessionId;
	}

	async prompt(
		sessionId: string,
		prompt: string | GeminiAcpPromptPart[],
		onUpdate?: GeminiAcpPromptUpdateHandler,
		options: GeminiAcpPromptOptions = {},
	): Promise<string> {
		const state: PromptState = { accumulatedText: "", onUpdate };
		this.promptStates.set(sessionId, state);
		traceAcp("prompt.size", {
			connectionId: this.rpc.connectionId,
			inputChars:
				typeof prompt === "string"
					? prompt.length
					: prompt.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0),
		});
		try {
			await this.rpc.request(
				"session/prompt",
				{
					sessionId,
					prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
				},
				{
					signal: options.signal,
					timeoutMs: acpTimeoutMs("PI_GEMINI_ACP_PROMPT_TIMEOUT_MS", DEFAULT_PROMPT_TIMEOUT_MS),
					onAbort: () => this.rpc.notify("session/cancel", { sessionId }),
					abortMode: options.returnTextOnAbort ? "resolve" : "reject",
				},
			);
			return state.accumulatedText.trim();
		} finally {
			this.promptStates.delete(sessionId);
		}
	}

	async close(): Promise<void> {
		// JsonRpcStdioClient.close() handles process-group kill with SIGTERM→SIGKILL escalation.
		await this.rpc.close();
	}

	private async handleAgentRequest(message: JsonRpcRequest): Promise<unknown> {
		if (message.method === "session/request_permission") {
			const optionId = permissionOptionId(message.params, this.permissionPolicy);
			traceAcp("permission", {
				connectionId: this.rpc.connectionId,
				capability: permissionCapabilityForRequest(message.params) ?? "unknown",
				outcome: optionId ? "selected" : "cancelled",
			});
			return {
				outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
			};
		}
		if (message.method === "fs/read_text_file") {
			return await this.handleReadTextFileRequest(message);
		}
		throw new JsonRpcResponseError(-32601, `Method not found: ${message.method}`);
	}

	private async handleReadTextFileRequest(message: JsonRpcRequest): Promise<unknown> {
		const requestedPath = coerceString(asRecord(message.params)?.path);
		const normalizedPath = requestedPath ? normalizeRequestedFilePath(requestedPath) : undefined;
		const resolvedPath = normalizedPath
			? this.allowedReadPathForRequest(normalizedPath)
			: undefined;
		if (!resolvedPath) {
			throw new JsonRpcResponseError(
				-32000,
				"Gemini ACP file read was denied by the Pi allowlist.",
			);
		}
		try {
			const stat = await lstat(resolvedPath);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				throw new JsonRpcResponseError(
					-32000,
					"Gemini ACP file read was denied for a non-regular file.",
				);
			}
			if (stat.size > MAX_CLIENT_READ_BYTES) {
				throw new JsonRpcResponseError(
					-32000,
					"Gemini ACP file read was denied because the file is too large.",
				);
			}
			return { content: await readFile(resolvedPath, "utf8") };
		} catch (cause) {
			if (cause instanceof JsonRpcResponseError) throw cause;
			throw new JsonRpcResponseError(
				-32000,
				cause instanceof Error ? cause.message : "Gemini ACP file read failed.",
			);
		}
	}

	private allowedReadPathForRequest(requestedPath: string): string | undefined {
		const candidates = path.isAbsolute(requestedPath)
			? [path.resolve(requestedPath)]
			: [path.resolve(this.sessionCwd, requestedPath), path.resolve(requestedPath)];
		return candidates.find((candidate) => this.allowedReadPaths.has(candidate));
	}

	private handleNotification(message: JsonRpcNotification): void {
		if (message.method === "session/update") this.collectUpdate(message.params);
	}

	private collectUpdate(params: unknown): void {
		const record = asRecord(params);
		const update = asRecord(record?.update);
		traceAcp("session.update", {
			connectionId: this.rpc.connectionId,
			update: coerceString(update?.sessionUpdate) ?? "other",
		});
		if (update?.sessionUpdate !== "agent_message_chunk") return;
		const content = asRecord(update.content);
		if (content?.type !== "text" || typeof content.text !== "string") return;
		const state = this.promptStateForUpdate(record, update);
		if (!state) return;
		state.accumulatedText += content.text;
		this.emitPromptUpdate(state, content.text);
	}

	private promptStateForUpdate(
		record: Record<string, unknown> | undefined,
		update: Record<string, unknown>,
	): PromptState | undefined {
		const sessionId = coerceString(record?.sessionId) ?? coerceString(update.sessionId);
		if (sessionId) return this.promptStates.get(sessionId);
		if (this.promptStates.size !== 1) return undefined;
		return this.promptStates.values().next().value;
	}

	private emitPromptUpdate(state: PromptState, text: string): void {
		const onUpdate = state.onUpdate;
		if (!onUpdate) return;
		void Promise.resolve(
			onUpdate({
				type: "chunk",
				text,
				accumulatedText: state.accumulatedText,
			}),
		).catch(() => {
			/* Streaming callbacks must not destabilize the ACP session. */
		});
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
	const option = options.find((candidate) => asRecord(candidate)?.kind === "allow_once");
	return coerceString(asRecord(option)?.optionId);
}

function permissionCapabilityForRequest(
	params: unknown,
): "filesystemRead" | "filesystemWrite" | "terminal" | undefined {
	const toolCall = asRecord(asRecord(params)?.toolCall);
	// ACP kind is authoritative. Never classify from command arguments or diff contents.
	switch (toolCall?.kind) {
		case "execute":
			return "terminal";
		case "edit":
		case "delete":
		case "move":
			return "filesystemWrite";
		case "read":
			return "filesystemRead";
		case undefined:
			break;
		default:
			return undefined;
	}
	// Compatibility with older agents that sent only a tool name.
	const text = (coerceString(toolCall?.name) ?? "").replaceAll("_", " ").toLowerCase();
	if (/(^|[^a-z])(terminal|shell|command|execute|exec)([^a-z]|$)/u.test(text)) {
		return "terminal";
	}
	if (/(^|[^a-z])(write|modify|delete|create|overwrite|edit)([^a-z]|$)/u.test(text)) {
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

function normalizeRequestedFilePath(value: string): string {
	if (!value.startsWith("file://")) return value;
	try {
		return decodeURI(value.slice("file://".length));
	} catch {
		return value.slice("file://".length);
	}
}

/** Sends SIGTERM to the entire process group, killing both the ACP wrapper and its children. */
function killProcessGroup(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

function abortError(): Error {
	return new DOMException("Gemini ACP request aborted", "AbortError");
}
