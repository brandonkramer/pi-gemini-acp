import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	JsonRpcResponseError,
	JsonRpcStdioClient,
	type JsonRpcMessage,
} from "../jsonrpc-stdio.js";

describe("JsonRpcStdioClient", () => {
	it("correlates request responses by id", async () => {
		const child = new FakeChildProcess();
		const client = new JsonRpcStdioClient(child.asChild());
		const writes = collectClientMessages(child, 1);

		const result = client.request("example/do", { ok: true });
		const [request] = await writes;
		child.send({ jsonrpc: "2.0", id: request?.id, result: { done: true } });

		await expect(result).resolves.toEqual({ done: true });
	});

	it("rejects error responses", async () => {
		const child = new FakeChildProcess();
		const client = new JsonRpcStdioClient(child.asChild());
		const writes = collectClientMessages(child, 1);

		const result = client.request("example/fail");
		const [request] = await writes;
		child.send({
			jsonrpc: "2.0",
			id: request?.id,
			error: { code: -32000, message: "boom" },
		});

		await expect(result).rejects.toThrow("boom");
	});

	it("handles incoming requests and writes success responses", async () => {
		const child = new FakeChildProcess();
		const client = new JsonRpcStdioClient(child.asChild(), {
			onRequest: (message) => ({ echoed: message.params }),
		});
		const writes = collectClientMessages(child, 1);

		child.send({
			jsonrpc: "2.0",
			id: "agent-1",
			method: "agent/ask",
			params: { question: true },
		});

		expect(await writes).toEqual([
			{
				jsonrpc: "2.0",
				id: "agent-1",
				result: { echoed: { question: true } },
			},
		]);
		await client.close();
	});

	it("handles incoming request errors", async () => {
		const child = new FakeChildProcess();
		const client = new JsonRpcStdioClient(child.asChild(), {
			onRequest: () => {
				throw new JsonRpcResponseError(-32601, "missing");
			},
		});
		const writes = collectClientMessages(child, 1);

		child.send({ jsonrpc: "2.0", id: 4, method: "missing" });

		expect(await writes).toEqual([
			{
				jsonrpc: "2.0",
				id: 4,
				error: { code: -32601, message: "missing" },
			},
		]);
		await client.close();
	});

	it("dispatches notifications", async () => {
		const child = new FakeChildProcess();
		const notifications: JsonRpcMessage[] = [];
		const client = new JsonRpcStdioClient(child.asChild(), {
			onNotification: (message) => {
				notifications.push(message);
			},
		});

		child.send({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } });
		await Promise.resolve();

		expect(notifications).toEqual([
			{ jsonrpc: "2.0", method: "session/update", params: { n: 1 } },
		]);
		await client.close();
	});

	it("handles partial lines and multiple messages in one chunk", async () => {
		const child = new FakeChildProcess();
		const client = new JsonRpcStdioClient(child.asChild());
		const writes = collectClientMessages(child, 2);

		const first = client.request("first");
		const second = client.request("second");
		const [firstRequest, secondRequest] = await writes;
		const firstResponse = JSON.stringify({
			jsonrpc: "2.0",
			id: firstRequest?.id,
			result: "one",
		});
		const secondResponse = JSON.stringify({
			jsonrpc: "2.0",
			id: secondRequest?.id,
			result: "two",
		});
		child.stdout.write(firstResponse.slice(0, 8));
		child.stdout.write(`${firstResponse.slice(8)}\n${secondResponse}\n`);

		await expect(first).resolves.toBe("one");
		await expect(second).resolves.toBe("two");
	});

	it("aborts requests and lets callers send cancellation notifications", async () => {
		const child = new FakeChildProcess();
		const client = new JsonRpcStdioClient(child.asChild());
		const writes = collectClientMessages(child, 2);
		const controller = new AbortController();

		const result = client.request("slow", undefined, {
			signal: controller.signal,
			onAbort: () => client.notify("session/cancel", { sessionId: "s1" }),
		});
		controller.abort();

		const [request, notification] = await writes;
		expect(request?.method).toBe("slow");
		expect(notification).toEqual({
			jsonrpc: "2.0",
			method: "session/cancel",
			params: { sessionId: "s1" },
		});
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
	});

	it("rejects all pending requests on close", async () => {
		const child = new FakeChildProcess();
		const client = new JsonRpcStdioClient(child.asChild());
		const writes = collectClientMessages(child, 1);

		const result = client.request("never");
		await writes;
		await client.close();

		await expect(result).rejects.toThrow("JSON-RPC stdio client closed");
		expect(child.killed).toBe(true);
	});
});

class FakeChildProcess extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;

	asChild() {
		return this as never;
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}

	send(message: JsonRpcMessage): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

function collectClientMessages(
	child: FakeChildProcess,
	count: number,
): Promise<JsonRpcMessage[]> {
	const messages: JsonRpcMessage[] = [];
	let buffer = "";
	return new Promise((resolve) => {
		child.stdin.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) messages.push(JSON.parse(line) as JsonRpcMessage);
				if (messages.length === count) resolve(messages);
				newline = buffer.indexOf("\n");
			}
		});
	});
}
