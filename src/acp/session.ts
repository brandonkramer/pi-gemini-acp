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
	GeminiAcpPromptActivity,
	GeminiAcpPromptObservers,
	GeminiAcpPromptOutcome,
	GeminiAcpPromptPart,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpPromptUsage,
} from "./client.ts";
import {
	JsonRpcResponseError,
	JsonRpcStdioClient,
	JsonRpcTimeoutError,
	type JsonRpcNotification,
	type JsonRpcRequest,
} from "./jsonrpc-stdio.ts";
import { acpToolKind } from "./tool-kind.ts";
import { acpTimeoutMs, traceAcp, type TraceFields } from "./trace.ts";

/**
 * Total deadline for one ACP prompt. A turn can run many Gemini tool calls (edits, builds, tests),
 * and a timeout discards its answer, so this only guards against a peer that never responds.
 */
export const DEFAULT_PROMPT_TIMEOUT_MS = 1_800_000;

/**
 * A prompt that sends no update for this long, while none of Gemini's own tool calls is running, is
 * treated as stalled. Thought and tool updates arrive every few seconds while Gemini works, and
 * long tool runs (builds, tests) do not count.
 */
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 600_000;
const PROMPT_IDLE_TIMEOUT_ENV = "PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS";

/**
 * A prompt was cancelled because Gemini stopped sending progress. Like other timeouts it is never
 * replayed (Gemini may already have changed files) and the process is not reused.
 */
export class GeminiAcpIdleTimeoutError extends JsonRpcTimeoutError {}

/**
 * A single Gemini tool call may run this long before the turn is cancelled. The idle limit ignores
 * running tools, so without this a hung tool (a web search stuck in server-side retries, a command
 * waiting for input) holds the turn until the total deadline.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
const TOOL_TIMEOUT_ENV = "PI_GEMINI_ACP_TOOL_TIMEOUT_MS";

/**
 * A prompt was cancelled because one of Gemini's tool calls ran longer than the per-tool limit. ACP
 * cannot cancel a single tool call, so the whole turn ends; it is never replayed.
 */
export class GeminiAcpToolTimeoutError extends JsonRpcTimeoutError {}

/** Controls cancellation behavior and observers for one in-flight ACP prompt turn. */
export interface GeminiAcpPromptOptions extends GeminiAcpPromptObservers {
	signal?: AbortSignal;
	returnTextOnAbort?: boolean;
}

const MAX_CLIENT_READ_BYTES = 1_000_000;

interface PromptState {
	accumulatedText: string;
	onUpdate?: GeminiAcpPromptUpdateHandler;
	onActivity?: GeminiAcpPromptObservers["onActivity"];
	/** Records progress for the stall detector. */
	touch?: () => void;
	/** Starts or stops per-tool limits after `runningTools` changed. */
	syncTools?: () => void;
	/** Gemini tool calls that started and have not completed or failed yet. */
	runningTools: Set<string>;
	/** Metadata-only counters for the `prompt.end` trace record. */
	stats: PromptStats;
}

interface PromptStats {
	startedAt: number;
	/** Start time and kind of each tool call, by id; kept after completion to count calls once. */
	tools: Map<string, { startedAt: number; kind?: string; ended: boolean }>;
	permissions: number;
	thoughtChunks: number;
	firstTextAt?: number;
	longestToolMs: number;
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
	/** Gemini CLI approval mode per session, from session/new and current_mode_update. */
	private readonly approvalModes = new Map<string, string>();
	/** Sessions whose permissive approval mode was already reported to a prompt observer. */
	private readonly reportedApprovalModes = new Set<string>();
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
		// sessions. Chat processes get the identity of their working directory in
		// settings.env (withGitIdentityForCwd), which wins below; others fall back
		// to Pi's working directory (process.cwd()).
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
		this.recordApprovalMode(sessionId, asRecord(asRecord(result)?.modes)?.currentModeId);
		return sessionId;
	}

	async prompt(
		sessionId: string,
		prompt: string | GeminiAcpPromptPart[],
		onUpdate?: GeminiAcpPromptUpdateHandler,
		options: GeminiAcpPromptOptions = {},
	): Promise<string> {
		const state: PromptState = {
			accumulatedText: "",
			onUpdate,
			onActivity: options.onActivity,
			runningTools: new Set(),
			stats: {
				startedAt: performance.now(),
				tools: new Map(),
				permissions: 0,
				thoughtChunks: 0,
				longestToolMs: 0,
			},
		};
		const idle = new PromptWatchdog(
			promptIdleTimeoutMs(),
			toolTimeoutMs(),
			state.runningTools,
			(reason, kind) =>
				traceAcp(reason === "idle" ? "prompt.idle_timeout" : "prompt.tool_timeout", {
					connectionId: this.rpc.connectionId,
					kind,
				}),
		);
		state.touch = () => idle.touch();
		state.syncTools = () => idle.syncTools(state.stats.tools);
		const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
		this.promptStates.set(sessionId, state);
		this.reportApprovalMode(sessionId, state);
		traceAcp("prompt.size", {
			connectionId: this.rpc.connectionId,
			inputChars:
				typeof prompt === "string"
					? prompt.length
					: prompt.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0),
		});
		let outcome: "ok" | "error" | "aborted" | "timeout" = "error";
		let stopReason: string | undefined;
		let inputTokens: number | undefined;
		try {
			const result = await this.rpc.request(
				"session/prompt",
				{
					sessionId,
					prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
				},
				{
					signal,
					timeoutMs: acpTimeoutMs("PI_GEMINI_ACP_PROMPT_TIMEOUT_MS", DEFAULT_PROMPT_TIMEOUT_MS),
					onAbort: () => this.rpc.notify("session/cancel", { sessionId }),
					abortMode: options.returnTextOnAbort ? "resolve" : "reject",
				},
			);
			if (idle.fired && !options.signal?.aborted) throw idle.error();
			const reported = promptOutcome(result);
			stopReason = reported.stopReason;
			inputTokens = reported.usage?.inputTokens;
			outcome = signal.aborted ? "aborted" : "ok";
			notifyObserver(() => options.onOutcome?.(reported));
			return state.accumulatedText.trim();
		} catch (error) {
			outcome =
				error instanceof JsonRpcTimeoutError || idle.fired
					? "timeout"
					: signal.aborted
						? "aborted"
						: "error";
			if (idle.fired && !options.signal?.aborted) throw idle.error();
			throw error;
		} finally {
			idle.dispose();
			this.promptStates.delete(sessionId);
			this.tracePromptEnd(state.stats, outcome, stopReason, inputTokens);
		}
	}

	/** One summary record per turn: where the time went, without any payload. */
	private tracePromptEnd(
		stats: PromptStats,
		outcome: TraceFields["outcome"],
		stopReason?: string,
		inputTokens?: number,
	) {
		const now = performance.now();
		for (const tool of stats.tools.values()) {
			if (!tool.ended) {
				stats.longestToolMs = Math.max(stats.longestToolMs, now - tool.startedAt);
			}
		}
		traceAcp("prompt.end", {
			connectionId: this.rpc.connectionId,
			outcome,
			stopReason,
			inputTokens,
			durationMs: now - stats.startedAt,
			firstTextMs:
				stats.firstTextAt === undefined ? undefined : stats.firstTextAt - stats.startedAt,
			toolCalls: stats.tools.size,
			permissions: stats.permissions,
			thoughtChunks: stats.thoughtChunks,
			longestToolMs: stats.longestToolMs,
		});
	}

	/** Times each Gemini tool call and traces its kind, final status and duration. */
	private trackToolTiming(stats: PromptStats, update: Record<string, unknown>): void {
		const id = coerceString(update.toolCallId);
		if (!id) return;
		const now = performance.now();
		let tool = stats.tools.get(id);
		if (!tool) {
			tool = { startedAt: now, ended: false };
			stats.tools.set(id, tool);
		}
		tool.kind ??= acpToolKind(update.kind);
		const status = coerceString(update.status);
		if (tool.ended || (status !== "completed" && status !== "failed")) return;
		tool.ended = true;
		const durationMs = now - tool.startedAt;
		stats.longestToolMs = Math.max(stats.longestToolMs, durationMs);
		traceAcp("tool.end", {
			connectionId: this.rpc.connectionId,
			kind: tool.kind,
			status,
			durationMs,
		});
	}

	async close(): Promise<void> {
		// JsonRpcStdioClient.close() handles process-group kill with SIGTERM→SIGKILL escalation.
		await this.rpc.close();
	}

	private async handleAgentRequest(message: JsonRpcRequest): Promise<unknown> {
		if (message.method === "session/request_permission") {
			const optionId = permissionOptionId(message.params, this.permissionPolicy);
			const capability = permissionCapabilityForRequest(message.params);
			const toolCall = asRecord(asRecord(message.params)?.toolCall);
			const kind = acpToolKind(toolCall?.kind);
			traceAcp("permission", {
				connectionId: this.rpc.connectionId,
				capability: capability ?? "unknown",
				kind,
				outcome: optionId ? "selected" : "cancelled",
			});
			const state = this.promptStateForUpdate(asRecord(message.params), {});
			state?.touch?.();
			if (state) state.stats.permissions += 1;
			this.emitActivity(state, {
				type: "permission",
				kind,
				title: coerceString(toolCall?.title),
				capability,
				outcome: optionId ? "selected" : "cancelled",
			});
			const toolCallId = coerceString(toolCall?.toolCallId);
			if (state && optionId && toolCallId) {
				// Gemini CLI sends no tool_call for a call that needs permission: the request is the
				// first Pi hears of it, and the call runs as soon as it is approved.
				const started = { ...toolCall, toolCallId, status: "in_progress" };
				trackRunningTool(state.runningTools, started);
				this.trackToolTiming(state.stats, started);
				state.syncTools?.();
				this.emitActivity(state, {
					type: "tool",
					toolCallId,
					kind,
					status: "in_progress",
					title: coerceString(toolCall?.title),
				});
			}
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
		const sessionUpdate = coerceString(update?.sessionUpdate) ?? "other";
		const isTool = sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update";
		traceAcp("session.update", {
			connectionId: this.rpc.connectionId,
			update: sessionUpdate,
			kind: isTool ? acpToolKind(update?.kind) : undefined,
			status: isTool ? coerceString(update?.status) : undefined,
		});
		if (!update) return;
		const state = this.promptStateForUpdate(record, update);
		if (!state) return;
		state.touch?.();
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const text = textContent(update.content);
				if (text === undefined) return;
				state.stats.firstTextAt ??= performance.now();
				state.accumulatedText += text;
				this.emitPromptUpdate(state, text);
				return;
			}
			case "agent_thought_chunk": {
				const text = textContent(update.content);
				state.stats.thoughtChunks += 1;
				if (text !== undefined) this.emitActivity(state, { type: "thought", text });
				return;
			}
			case "current_mode_update": {
				const sessionId = coerceString(record?.sessionId);
				if (sessionId) {
					this.recordApprovalMode(sessionId, update.currentModeId);
					this.reportApprovalMode(sessionId, state);
				}
				return;
			}
			case "tool_call":
			case "tool_call_update":
				trackRunningTool(state.runningTools, update);
				this.trackToolTiming(state.stats, update);
				state.syncTools?.();
				this.emitActivity(state, {
					type: "tool",
					toolCallId: coerceString(update.toolCallId),
					kind: acpToolKind(update.kind),
					status: coerceString(update.status),
					title: coerceString(update.title),
					output: toolContentText(update.content),
				});
				return;
			default:
				// Other updates (plans, mode and command lists, usage) are traced above only.
				break;
		}
	}

	private recordApprovalMode(sessionId: string, value: unknown): void {
		const mode = coerceString(value);
		if (!mode) return;
		if (this.approvalModes.get(sessionId) !== mode) this.reportedApprovalModes.delete(sessionId);
		this.approvalModes.set(sessionId, mode);
		traceAcp("session.mode", {
			connectionId: this.rpc.connectionId,
			mode: isApprovalMode(mode) ? mode : "other",
		});
	}

	/** Tells the prompt once per session and mode when Gemini will not ask for permission. */
	private reportApprovalMode(sessionId: string, state: PromptState): void {
		const mode = this.approvalModes.get(sessionId);
		if ((mode !== "autoEdit" && mode !== "yolo") || this.reportedApprovalModes.has(sessionId)) {
			return;
		}
		this.reportedApprovalModes.add(sessionId);
		this.emitActivity(state, { type: "approval_mode", mode });
	}

	private emitActivity(state: PromptState | undefined, activity: GeminiAcpPromptActivity): void {
		const onActivity = state?.onActivity;
		if (onActivity) notifyObserver(() => onActivity(activity));
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

const APPROVAL_MODES = ["default", "autoEdit", "yolo", "plan"] as const;

function isApprovalMode(mode: string): mode is (typeof APPROVAL_MODES)[number] {
	return (APPROVAL_MODES as readonly string[]).includes(mode);
}

/** Prompt idle limit in ms, or 0 when disabled with `PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS=0`. */
export function promptIdleTimeoutMs(): number {
	if (process.env[PROMPT_IDLE_TIMEOUT_ENV]?.trim() === "0") return 0;
	return acpTimeoutMs(PROMPT_IDLE_TIMEOUT_ENV, DEFAULT_PROMPT_IDLE_TIMEOUT_MS);
}

/** Per-tool limit in ms, or 0 when disabled with `PI_GEMINI_ACP_TOOL_TIMEOUT_MS=0`. */
export function toolTimeoutMs(): number {
	if (process.env[TOOL_TIMEOUT_ENV]?.trim() === "0") return 0;
	return acpTimeoutMs(TOOL_TIMEOUT_ENV, DEFAULT_TOOL_TIMEOUT_MS);
}

type WatchdogReason = "idle" | "tool";

/**
 * Cancels a prompt that stops sending progress while none of Gemini's tools is running, or whose
 * single tool call runs longer than the per-tool limit.
 */
class PromptWatchdog {
	readonly signal: AbortSignal;
	fired = false;
	private reason: WatchdogReason = "idle";
	private readonly controller = new AbortController();
	private readonly idleMs: number;
	private readonly toolMs: number;
	private readonly runningTools: ReadonlySet<string>;
	private readonly onFire: (reason: WatchdogReason, kind?: string) => void;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly toolTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		idleMs: number,
		toolMs: number,
		runningTools: ReadonlySet<string>,
		onFire: (reason: WatchdogReason, kind?: string) => void,
	) {
		this.idleMs = idleMs;
		this.toolMs = toolMs;
		this.runningTools = runningTools;
		this.onFire = onFire;
		this.signal = this.controller.signal;
		this.touch();
	}

	touch(): void {
		if (this.idleMs <= 0 || this.fired) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			// A running tool (build, test suite) may legitimately stay silent; the per-tool limit
			// and the total deadline still bound it.
			if (this.runningTools.size > 0) {
				this.touch();
				return;
			}
			this.fire("idle");
		}, this.idleMs);
		this.timer.unref();
	}

	/** Arms a timer for each newly running tool and clears the timers of finished ones. */
	syncTools(tools: ReadonlyMap<string, { kind?: string }>): void {
		if (this.toolMs <= 0 || this.fired) return;
		for (const [id, timer] of this.toolTimers) {
			if (!this.runningTools.has(id)) {
				clearTimeout(timer);
				this.toolTimers.delete(id);
			}
		}
		for (const id of this.runningTools) {
			if (this.toolTimers.has(id)) continue;
			const timer = setTimeout(() => this.fire("tool", tools.get(id)?.kind), this.toolMs);
			timer.unref();
			this.toolTimers.set(id, timer);
		}
	}

	private fire(reason: WatchdogReason, kind?: string): void {
		if (this.fired) return;
		this.fired = true;
		this.reason = reason;
		this.onFire(reason, kind);
		this.controller.abort();
	}

	error(): JsonRpcTimeoutError {
		if (this.reason === "tool") {
			return new GeminiAcpToolTimeoutError(
				`A Gemini tool call ran for more than ${minutes(this.toolMs)} min, so the turn was cancelled. Check the working tree before retrying. Set ${TOOL_TIMEOUT_ENV} to change this limit (0 disables it).`,
			);
		}
		return new GeminiAcpIdleTimeoutError(
			`Gemini ACP sent no progress for ${minutes(this.idleMs)} min while no Gemini tool was running, so the turn was cancelled. Check the working tree before retrying. Set ${PROMPT_IDLE_TIMEOUT_ENV} to change this limit (0 disables it).`,
		);
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		for (const timer of this.toolTimers.values()) clearTimeout(timer);
		this.toolTimers.clear();
	}
}

function minutes(ms: number): number {
	return Math.round((ms / 60_000) * 10) / 10;
}

function trackRunningTool(runningTools: Set<string>, update: Record<string, unknown>): void {
	const id = coerceString(update.toolCallId);
	if (!id) return;
	const status = coerceString(update.status);
	if (status === "completed" || status === "failed") runningTools.delete(id);
	// A new tool_call without a status is pending, per ACP.
	else if (status !== undefined || update.sessionUpdate === "tool_call") runningTools.add(id);
}

/** Observers must not destabilize the ACP session. */
function notifyObserver(callback: () => void): void {
	try {
		callback();
	} catch {
		/* ignored */
	}
}

function textContent(value: unknown): string | undefined {
	const content = asRecord(value);
	return content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

/**
 * Joins the text of an ACP tool call's `content` list. Text blocks are kept verbatim; a diff block
 * becomes a line naming the file it changes. Terminal blocks carry no text and are skipped.
 */
function toolContentText(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const parts: string[] = [];
	for (const item of value) {
		const block = asRecord(item);
		if (block?.type === "content") {
			const text = textContent(block.content);
			if (text !== undefined) parts.push(text);
		} else if (block?.type === "diff") {
			const file = coerceString(block.path);
			if (file) parts.push(`Changed ${file}`);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Reads Gemini CLI's `session/prompt` result: `stopReason` and `_meta.quota` token counts. */
function promptOutcome(result: unknown): GeminiAcpPromptOutcome {
	const record = asRecord(result);
	const quota = asRecord(asRecord(record?.["_meta"])?.quota);
	return { stopReason: coerceString(record?.stopReason), usage: quotaUsage(quota) };
}

function quotaUsage(quota: Record<string, unknown> | undefined): GeminiAcpPromptUsage | undefined {
	const total = tokenCount(quota?.token_count);
	if (!total) return undefined;
	const models = Array.isArray(quota?.model_usage) ? quota.model_usage : [];
	return {
		...total,
		models: models.flatMap((entry) => {
			const record = asRecord(entry);
			const model = coerceString(record?.model);
			const counts = tokenCount(record?.token_count);
			return model && counts ? [{ model, ...counts }] : [];
		}),
	};
}

function tokenCount(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
	const record = asRecord(value);
	const inputTokens = record?.input_tokens;
	const outputTokens = record?.output_tokens;
	if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
	if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
	return { inputTokens, outputTokens };
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
