import { Readable, Writable } from "node:stream";

/** @file Tests for the agy-acp ACP stdio adapter. */
import { describe, expect, it } from "vitest";

import { createAgyAcpAdapter } from "../adapter.ts";

interface CapturedMessage {
	jsonrpc?: "2.0";
	id?: number | string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

function createMockStreams(): { stdin: Readable; stdout: Writable; messages: CapturedMessage[] } {
	const messages: CapturedMessage[] = [];
	const stdin = new Readable({
		read() {
			// intentional no-op for mock
		},
	});
	const stdout = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			const lines = chunk.toString().trim().split("\n");
			for (const line of lines) {
				if (line) {
					try {
						messages.push(JSON.parse(line) as CapturedMessage);
					} catch {
						// ignore non-json
					}
				}
			}
			callback();
		},
	});
	return { stdin, stdout, messages };
}

function makeTestAdapter(
	options: {
		agyCommand?: string;
		agyArgs?: string[];
		sandbox?: boolean;
	} = {},
) {
	const { stdin, stdout, messages } = createMockStreams();
	const adapter = createAgyAcpAdapter({
		agyCommand: options.agyCommand ?? "agy",
		agyArgs: options.agyArgs ?? [],
		sandbox: options.sandbox,
		stdin,
		stdout,
	});
	return { adapter, stdin, messages };
}

/** Helper to send a single JSON-RPC request to a started adapter and collect the response. */
async function sendRequest(
	stdin: Readable,
	messages: CapturedMessage[],
	request: { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown },
	delayMs = 10,
): Promise<CapturedMessage[]> {
	const before = messages.length;
	stdin.push(JSON.stringify(request) + "\n");
	await new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});
	return messages.slice(before);
}

describe("agy-acp adapter", () => {
	it("responds to initialize with capabilities", async () => {
		const { adapter, stdin, messages } = makeTestAdapter();
		adapter.start();
		const responses = await sendRequest(stdin, messages, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
		});
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: 1,
				agentInfo: { name: "agy-acp", version: "0.1.0" },
				agentCapabilities: {
					promptCapabilities: {
						embeddedContext: false,
						image: false,
						audio: false,
					},
				},
			},
		});
	});

	it("responds to session/new with a dummy session id", async () => {
		const { adapter, stdin, messages } = makeTestAdapter();
		adapter.start();
		const responses = await sendRequest(stdin, messages, {
			jsonrpc: "2.0",
			id: 2,
			method: "session/new",
		});
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 2,
			result: { sessionId: "agy-session" },
		});
	});

	it("responds with error for unknown method", async () => {
		const { adapter, stdin, messages } = makeTestAdapter();
		adapter.start();
		const responses = await sendRequest(stdin, messages, {
			jsonrpc: "2.0",
			id: 3,
			method: "unknown",
		});
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -32601, message: "Method not found: unknown" },
		});
	});

	it("extracts plain text prompt", async () => {
		const { adapter, stdin, messages } = makeTestAdapter({
			agyCommand: "node",
			agyArgs: ["-e", "console.log(process.argv[process.argv.length - 1])", "--"],
		});
		adapter.start();
		const responses = await sendRequest(
			stdin,
			messages,
			{ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { prompt: "hello world" } },
			100,
		);
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 4,
			result: "hello world",
		});
	});

	it("extracts prompt from parts array", async () => {
		const { adapter, stdin, messages } = makeTestAdapter({
			agyCommand: "node",
			agyArgs: ["-e", "console.log(process.argv[process.argv.length - 1])", "--"],
		});
		adapter.start();
		const responses = await sendRequest(
			stdin,
			messages,
			{
				jsonrpc: "2.0",
				id: 5,
				method: "session/prompt",
				params: {
					prompt: [
						{ type: "text", text: "hello " },
						{ type: "text", text: "world" },
					],
				},
			},
			100,
		);
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 5,
			result: "hello world",
		});
	});

	it("returns error for missing prompt", async () => {
		const { adapter, stdin, messages } = makeTestAdapter();
		adapter.start();
		const responses = await sendRequest(stdin, messages, {
			jsonrpc: "2.0",
			id: 6,
			method: "session/prompt",
			params: {},
		});
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 6,
			error: { code: -32602, message: "Missing or invalid prompt parameter" },
		});
	});

	it("passes sandbox flag when enabled", async () => {
		const { adapter, stdin, messages } = makeTestAdapter({
			agyCommand: "node",
			agyArgs: [
				"-e",
				"const idx = process.argv.indexOf('--sandbox'); console.log(idx > -1);",
				"--",
			],
			sandbox: true,
		});
		adapter.start();
		const responses = await sendRequest(
			stdin,
			messages,
			{ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { prompt: "test" } },
			100,
		);
		expect(responses).toHaveLength(1);
		expect(responses[0]).toMatchObject({
			jsonrpc: "2.0",
			id: 7,
			result: "true",
		});
	});
});
