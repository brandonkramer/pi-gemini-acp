import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonRpcTimeoutError } from "../jsonrpc-stdio.ts";
import { AcpProcessSession, GeminiAcpIdleTimeoutError, promptIdleTimeoutMs } from "../session.ts";
import { acpTimeoutMs, traceAcp } from "../trace.ts";

// A local protocol peer, not Gemini: no credentials, network requests, or project tools.
const peer = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
let promptId;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (msg.params.clientCapabilities.fs.writeTextFile || msg.params.clientCapabilities.terminal) {
      send({ id: msg.id, error: { code: -32603, message: 'unsupported capabilities advertised' } });
    } else send({ id: msg.id, result: {} });
  } else if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: 'private-session-id' } });
  } else if (msg.method === 'session/prompt') {
    promptId = msg.id;
    const text = msg.params.prompt[0].text;
    if (text === 'stall') return;
    const update = u => send({ method: 'session/update', params: { sessionId: 'private-session-id', update: u } });
    if (text === 'tool-stall') {
      update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'in_progress', kind: 'execute' });
      return;
    }
    if (text === 'slow') {
      let n = 0;
      const timer = setInterval(() => {
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '.' } });
        if (++n === 6) {
          clearInterval(timer);
          send({ id: promptId, result: { stopReason: 'end_turn' } });
        }
      }, 20);
      return;
    }
    send({ method: 'session/update', params: { sessionId: 'private-session-id', update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SECRET_THOUGHT' }
    } } });
    send({ method: 'session/request_permission', id: 'permission', params: {
      sessionId: 'private-session-id', toolCall: { kind: 'edit', title: 'SECRET_PATH', content: [{ newText: 'SECRET_DIFF shell' }] },
      options: [{ kind: 'allow_once', optionId: 'proceed_once' }]
    } });
  } else if (msg.id === 'permission') {
    if (msg.result.outcome.optionId !== 'proceed_once') {
      send({ id: promptId, error: { code: -32603, message: 'permission incorrectly denied' } });
    } else {
      send({ method: 'session/update', params: { sessionId: 'private-session-id', update: {
        sessionUpdate: 'tool_call', toolCallId: 'call-1', status: 'in_progress', title: 'SECRET_COMMAND', kind: 'edit'
      } } });
      send({ method: 'session/update', params: { sessionId: 'private-session-id', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed'
      } } });
      send({ method: 'session/update', params: { sessionId: 'private-session-id', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECRET_ANSWER' }
      } } });
      send({ id: promptId, result: { stopReason: 'end_turn', _meta: { quota: {
        token_count: { input_tokens: 120, output_tokens: 7 },
        model_usage: [{ model: 'gemini-2.5-flash', token_count: { input_tokens: 120, output_tokens: 7 } }]
      } } } });
    }
  }
});
`;

let dir: string;
let session: AcpProcessSession | undefined;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "pi-acp-protocol-"));
});
afterEach(async () => {
	await session?.close();
	session = undefined;
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

async function start() {
	session = await AcpProcessSession.start({
		command: process.execPath,
		args: ["-e", peer],
		permissionPolicy: { filesystemRead: true, filesystemWrite: true, terminal: true },
	});
	await session.initialize();
	return { session, id: await session.newSession(dir) };
}

describe("ACP session protocol and diagnostics", () => {
	it("records timing, progress and permission metadata without payloads", async () => {
		const file = path.join(dir, "trace.jsonl");
		vi.stubEnv("PI_GEMINI_ACP_TRACE_FILE", file);
		const { session: active, id } = await start();
		expect(await active.prompt(id, "SECRET_PROMPT")).toBe("SECRET_ANSWER");
		const text = await readFile(file, "utf8");
		expect(text).not.toMatch(/SECRET_|private-session-id/u);
		expect(text).not.toContain(dir);
		const records = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "rpc.end",
					method: "session/new",
					durationMs: expect.any(Number),
				}),
				expect.objectContaining({ event: "session.update", update: "agent_thought_chunk" }),
				expect.objectContaining({ event: "session.update", update: "tool_call" }),
				expect.objectContaining({
					event: "permission",
					capability: "filesystemWrite",
					kind: "edit",
					outcome: "selected",
				}),
				expect.objectContaining({ event: "prompt.size", inputChars: 13 }),
			]),
		);
		expect(new Set(records.map((record) => record.connectionId)).size).toBe(1);
	});

	it("reports thoughts, tool calls, permission decisions and token usage to observers", async () => {
		const { session: active, id } = await start();
		const activity: unknown[] = [];
		const outcomes: unknown[] = [];
		await active.prompt(id, "go", undefined, {
			onActivity: (item) => activity.push(item),
			onOutcome: (outcome) => outcomes.push(outcome),
		});
		expect(activity).toEqual([
			{ type: "thought", text: "SECRET_THOUGHT" },
			{
				type: "permission",
				kind: "edit",
				title: "SECRET_PATH",
				capability: "filesystemWrite",
				outcome: "selected",
			},
			{
				type: "tool",
				toolCallId: "call-1",
				kind: "edit",
				status: "in_progress",
				title: "SECRET_COMMAND",
			},
			{
				type: "tool",
				toolCallId: "call-1",
				kind: undefined,
				status: "completed",
				title: undefined,
			},
		]);
		expect(outcomes).toEqual([
			{
				stopReason: "end_turn",
				usage: {
					inputTokens: 120,
					outputTokens: 7,
					models: [{ model: "gemini-2.5-flash", inputTokens: 120, outputTokens: 7 }],
				},
			},
		]);
	});

	it.skipIf(process.platform === "win32")("creates private trace files", async () => {
		const file = path.join(dir, "trace.jsonl");
		vi.stubEnv("PI_GEMINI_ACP_TRACE_FILE", file);
		traceAcp("test");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it("bounds a prompt that never returns and invalidates its transport", async () => {
		vi.stubEnv("PI_GEMINI_ACP_PROMPT_TIMEOUT_MS", "30");
		const { session: active, id } = await start();
		await expect(active.prompt(id, "stall")).rejects.toBeInstanceOf(JsonRpcTimeoutError);
		await expect(active.newSession(dir)).rejects.toBeInstanceOf(JsonRpcTimeoutError);
	});

	it("cancels a prompt that stops sending progress", async () => {
		vi.stubEnv("PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS", "40");
		const { session: active, id } = await start();
		await expect(active.prompt(id, "stall")).rejects.toBeInstanceOf(GeminiAcpIdleTimeoutError);
	});

	it("keeps waiting while progress arrives", async () => {
		vi.stubEnv("PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS", "80");
		const { session: active, id } = await start();
		// Six updates 20 ms apart: 120 ms in total, longer than the idle limit.
		await expect(active.prompt(id, "slow")).resolves.toBe("");
	});

	it("does not treat a running Gemini tool as a stall", async () => {
		vi.stubEnv("PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS", "20");
		vi.stubEnv("PI_GEMINI_ACP_PROMPT_TIMEOUT_MS", "150");
		const { session: active, id } = await start();
		const error = await active.prompt(id, "tool-stall").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(JsonRpcTimeoutError);
		expect(error).not.toBeInstanceOf(GeminiAcpIdleTimeoutError);
	});

	it("disables the stall limit with 0 and rejects invalid values", () => {
		vi.stubEnv("PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS", "0");
		expect(promptIdleTimeoutMs()).toBe(0);
		vi.stubEnv("PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS", "-5");
		expect(promptIdleTimeoutMs()).toBe(600_000);
	});

	it("bounds initialization when the peer never responds", async () => {
		vi.stubEnv("PI_GEMINI_ACP_STARTUP_TIMEOUT_MS", "30");
		session = await AcpProcessSession.start({
			command: process.execPath,
			args: ["-e", "process.stdin.resume()"],
		});
		await expect(session.initialize()).rejects.toBeInstanceOf(JsonRpcTimeoutError);
	});

	it("ignores trace output errors and redacts unknown method/update names", async () => {
		vi.stubEnv("PI_GEMINI_ACP_TRACE_FILE", dir);
		expect(() => traceAcp("test")).not.toThrow();
		const file = path.join(dir, "trace.jsonl");
		vi.stubEnv("PI_GEMINI_ACP_TRACE_FILE", file);
		traceAcp("test", { method: "SECRET_METHOD", update: "SECRET_UPDATE" });
		expect(await readFile(file, "utf8")).not.toContain("SECRET");
	});

	it("rejects invalid deadline overrides", () => {
		for (const value of ["0", "-1", "NaN", "1.5", "2147483648"]) {
			vi.stubEnv("PI_GEMINI_ACP_STARTUP_TIMEOUT_MS", value);
			expect(acpTimeoutMs("PI_GEMINI_ACP_STARTUP_TIMEOUT_MS", 60_000)).toBe(60_000);
		}
	});
});
