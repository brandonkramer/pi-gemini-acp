import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	permissionPolicyCapabilities,
	requirePermissionCapability,
} from "../config/permission-policy.js";
import type {
	GeminiAcpPermissionPolicy,
	SearchProviderMetadata,
	SearchResultItem,
} from "../types.js";
import { normalizeUrl } from "../url/normalize.js";

/** Local command settings used to launch a Gemini ACP subprocess. */
export interface GeminiAcpCommandSettings {
	command: string;
	args?: string[];
	permissionPolicy?: GeminiAcpPermissionPolicy;
}

/** Search prompt request normalized before sending through ACP. */
export interface GeminiAcpSearchRequest {
	query: string;
	maxResults: number;
	cwd?: string;
}

/** Plain text prompt request sent through a Gemini ACP session. */
export interface GeminiAcpPromptRequest {
	prompt: string;
	cwd?: string;
}

/** Streaming assistant text emitted by a Gemini ACP session update. */
export interface GeminiAcpPromptChunk {
	type: "chunk";
	text: string;
	accumulatedText: string;
}

/** Callback for prompt chunk updates exposed by fake and stdio ACP clients. */
export type GeminiAcpPromptUpdateHandler = (
	update: GeminiAcpPromptChunk,
) => void | Promise<void>;

/** Narrow Gemini ACP capability surface used by Pi tools. */
export interface GeminiAcpClient {
	search(
		request: GeminiAcpSearchRequest,
		signal?: AbortSignal,
	): Promise<SearchResultItem[]>;
	prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string>;
}

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

/** JSON-RPC-over-stdio Gemini ACP client with minimal Pi capabilities. */
export class StdioGeminiAcpClient implements GeminiAcpClient {
	constructor(private readonly settings: GeminiAcpCommandSettings) {}

	async search(
		request: GeminiAcpSearchRequest,
		signal?: AbortSignal,
	): Promise<SearchResultItem[]> {
		const session = await AcpProcessSession.start(this.settings, signal);
		try {
			await session.initialize();
			const sessionId = await session.newSession(request.cwd ?? process.cwd());
			const text = await session.prompt(sessionId, searchPrompt(request));
			return normalizeGeminiAcpSearchResults(
				parseSearchPayload(text),
				geminiMetadata(),
			);
		} finally {
			await session.close();
		}
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		const session = await AcpProcessSession.start(this.settings, signal);
		try {
			await session.initialize();
			const sessionId = await session.newSession(request.cwd ?? process.cwd());
			return await session.prompt(sessionId, request.prompt, onUpdate);
		} finally {
			await session.close();
		}
	}
}

/** Normalizes defensive Gemini ACP search payloads into stable Pi search items. */
export function normalizeGeminiAcpSearchResults(
	raw: unknown,
	metadata: SearchProviderMetadata = geminiMetadata(),
): SearchResultItem[] {
	const candidates = Array.isArray(raw) ? raw : recordsFromObject(raw);
	return candidates.flatMap((entry, index) => {
		const record = asRecord(entry);
		const url = record
			? (stringValue(record.url) ??
				stringValue(record.link) ??
				stringValue(record.uri))
			: undefined;
		if (!record || !url) return [];
		try {
			const normalizedUrl = normalizeUrl(url);
			return [
				{
					title: stringValue(record.title) ?? normalizedUrl,
					url,
					normalizedUrl,
					snippet:
						stringValue(record.snippet) ??
						stringValue(record.summary) ??
						stringValue(record.description),
					ranking: numberValue(record.ranking) ?? index + 1,
					source: { ...metadata, raw: record },
				},
			];
		} catch {
			return [];
		}
	});
}

function searchPrompt(request: GeminiAcpSearchRequest): string {
	return [
		`Run a grounded web search for: ${request.query}`,
		`Return up to ${request.maxResults} results as JSON only.`,
		'Use this exact shape: [{"title": string, "url": string, "snippet": string}]',
		"Do not include Markdown fences or explanatory text.",
	].join("\n");
}

/** Extracts JSON search payloads from raw assistant text. */
export function parseSearchPayload(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return [];
	try {
		return JSON.parse(trimmed);
	} catch {
		/* extract JSON below */
	}
	const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed)?.[1]?.trim();
	if (fenced) {
		try {
			return JSON.parse(fenced);
		} catch {
			/* continue */
		}
	}
	const start = firstJsonStart(trimmed);
	const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			/* fall through */
		}
	}
	return [];
}

function firstJsonStart(value: string): number {
	const objectStart = value.indexOf("{");
	const arrayStart = value.indexOf("[");
	if (objectStart < 0) return arrayStart;
	if (arrayStart < 0) return objectStart;
	return Math.min(objectStart, arrayStart);
}

function recordsFromObject(raw: unknown): unknown[] {
	const record = asRecord(raw);
	if (!record) return [];
	for (const key of ["results", "items", "sources", "citations"]) {
		const value = record[key];
		if (Array.isArray(value)) return value;
	}
	return [];
}

function geminiMetadata(): SearchProviderMetadata {
	return {
		provider: "gemini-acp",
		kind: "gemini-acp",
		requiresCloud: false,
		requiresApiKey: false,
		requiresLocalAuth: true,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

class AcpProcessSession {
	private nextId = 1;
	private readonly pending = new Map<number | string, PendingRequest>();
	private readonly agentText: string[] = [];
	private promptUpdateHandler?: GeminiAcpPromptUpdateHandler;
	private stdoutBuffer = "";
	private stderrBuffer = "";

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

	static async start(
		settings: GeminiAcpCommandSettings,
		signal?: AbortSignal,
	): Promise<AcpProcessSession> {
		const child = spawn(settings.command, settings.args ?? [], {
			stdio: "pipe",
			env: process.env,
		});
		const session = new AcpProcessSession(child, settings.permissionPolicy);
		if (signal?.aborted) throw abortError();
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
		if (typeof sessionId !== "string")
			throw new Error("Gemini ACP did not return a sessionId");
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
		this.child.stdin.end();
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
			if (message.error)
				pending.reject(
					new Error(message.error.message ?? "Gemini ACP request failed"),
				);
			else pending.resolve(message.result);
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
	if (/(^|[^a-z])(terminal|shell|command|execute|exec)([^a-z]|$)/u.test(text))
		return "terminal";
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

function abortError(): Error {
	return new DOMException("Gemini ACP request aborted", "AbortError");
}
