#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_SETTINGS_PATH = join(
	homedir(),
	".pi",
	"gemini-acp",
	"config",
	"settings.json",
);
const DEFAULT_QUERY =
	"Amsterdam Netherlands current weather temperature conditions";

function usage() {
	console.log(`Usage: node scripts/bench.mjs [options]

Bench the Gemini ACP search path by speaking JSON-RPC directly to the configured
Gemini ACP command. Reports phase timings for process startup/initialize,
session creation, grounded search prompt, JSON parse, and total time.

Options:
  --query <text>          Search query (default: ${DEFAULT_QUERY})
  --runs <n>              Number of measured runs (default: 3)
  --max-results <n>       Requested max search results (default: 5)
  --settings <path>       Settings JSON path (default: ${DEFAULT_SETTINGS_PATH})
  --command <name|path>   Override configured ACP executable
  --arg <value>           Extra/override ACP arg. Repeatable. If any --arg is
                          supplied, configured args are replaced by these args.
  --timeout-ms <n>        Per-run timeout in milliseconds (default: 60000)
  --json                  Emit machine-readable JSON only
  -h, --help              Show this help

Examples:
  node scripts/bench.mjs
  node scripts/bench.mjs --runs 5 --query "Amsterdam weather"
  node scripts/bench.mjs --command gemini --arg --acp
`);
}

function parseArgs(argv) {
	const options = {
		query: DEFAULT_QUERY,
		runs: 3,
		maxResults: 5,
		settingsPath: DEFAULT_SETTINGS_PATH,
		command: undefined,
		args: undefined,
		timeoutMs: 60_000,
		json: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = () => {
			const next = argv[index + 1];
			if (!next) throw new Error(`Missing value for ${arg}`);
			index += 1;
			return next;
		};
		switch (arg) {
			case "--query":
				options.query = value();
				break;
			case "--runs":
				options.runs = positiveInteger(value(), "--runs");
				break;
			case "--max-results":
				options.maxResults = positiveInteger(value(), "--max-results");
				break;
			case "--settings":
				options.settingsPath = resolve(value());
				break;
			case "--command":
				options.command = value();
				break;
			case "--arg":
				options.args ??= [];
				options.args.push(value());
				break;
			case "--timeout-ms":
				options.timeoutMs = positiveInteger(value(), "--timeout-ms");
				break;
			case "--json":
				options.json = true;
				break;
			case "-h":
			case "--help":
				usage();
				process.exit(0);
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function positiveInteger(raw, flag) {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return value;
}

async function loadCommandSettings(options) {
	let provider = {};
	try {
		const settings = JSON.parse(await readFile(options.settingsPath, "utf8"));
		provider = settings?.providers?.["gemini-acp"] ?? {};
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	return {
		command: options.command ?? provider.command ?? "gemini",
		args: options.args ?? provider.args ?? ["--acp"],
		settingsPath: options.settingsPath,
	};
}

function buildSearchPrompt(query, maxResults) {
	return [
		`Run a grounded web search for: ${query}`,
		`Return up to ${maxResults} results as JSON only.`,
		'Use this exact shape: [{"title": string, "url": string, "snippet": string}]',
		"Do not include Markdown fences or explanatory text.",
	].join("\n");
}

async function measureRun({
	command,
	args,
	query,
	maxResults,
	timeoutMs,
	run,
}) {
	const startedAt = performance.now();
	const child = spawn(command, args, {
		cwd: PROJECT_DIR,
		env: process.env,
		stdio: "pipe",
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	let nextId = 1;
	let stdoutBuffer = "";
	let stderrBuffer = "";
	const pending = new Map();
	const chunks = [];
	const timeout = setTimeout(() => {
		child.kill("SIGTERM");
		rejectAll(new Error(`Timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newline = stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = stdoutBuffer.slice(0, newline).trim();
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (line) handleMessage(JSON.parse(line));
			newline = stdoutBuffer.indexOf("\n");
		}
	});
	child.stderr.on("data", (chunk) => {
		stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4_000);
	});
	child.on("error", rejectAll);
	child.on("exit", (code, signal) => {
		if (pending.size === 0) return;
		rejectAll(
			new Error(`Gemini ACP exited with ${signal ?? code}: ${stderrBuffer}`),
		);
	});

	function handleMessage(message) {
		if (message.id !== undefined && message.method) {
			respondToAgentRequest(message);
			return;
		}
		if (message.method === "session/update") {
			const update = message.params?.update;
			if (
				update?.sessionUpdate === "agent_message_chunk" &&
				update.content?.type === "text" &&
				typeof update.content.text === "string"
			) {
				chunks.push(update.content.text);
			}
			return;
		}
		if (message.id === undefined) return;
		const pendingRequest = pending.get(message.id);
		if (!pendingRequest) return;
		pending.delete(message.id);
		if (message.error) {
			pendingRequest.reject(
				new Error(message.error.message ?? "Gemini ACP JSON-RPC error"),
			);
		} else {
			pendingRequest.resolve(message.result);
		}
	}

	function respondToAgentRequest(message) {
		if (message.method === "session/request_permission") {
			respond(message.id, { outcome: { outcome: "cancelled" } });
			return;
		}
		respond(message.id, undefined, {
			code: -32601,
			message: `Method not found: ${message.method}`,
		});
	}

	function request(method, params) {
		const id = nextId;
		nextId += 1;
		const promise = new Promise((resolveRequest, rejectRequest) => {
			pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return promise;
	}

	function respond(id, result, error) {
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`,
		);
	}

	function rejectAll(error) {
		for (const pendingRequest of pending.values()) pendingRequest.reject(error);
		pending.clear();
	}

	try {
		const initializeStart = performance.now();
		await request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "pi-gemini-acp-bench", version: "0.0.0" },
			clientCapabilities: { terminal: false },
		});
		const initializeMs = performance.now() - initializeStart;

		const sessionStart = performance.now();
		const session = await request("session/new", {
			cwd: PROJECT_DIR,
			mcpServers: [],
		});
		const sessionMs = performance.now() - sessionStart;
		if (typeof session?.sessionId !== "string") {
			throw new Error("Gemini ACP did not return a sessionId");
		}

		const promptStart = performance.now();
		await request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: buildSearchPrompt(query, maxResults) }],
		});
		const promptMs = performance.now() - promptStart;

		const parseStart = performance.now();
		const text = chunks.join("").trim();
		const parsed = parseSearchPayload(text);
		const parseMs = performance.now() - parseStart;

		return {
			run,
			totalMs: performance.now() - startedAt,
			initializeMs,
			sessionMs,
			promptMs,
			parseMs,
			results: Array.isArray(parsed) ? parsed.length : 0,
			bytes: text.length,
		};
	} finally {
		clearTimeout(timeout);
		child.stdin.end();
		if (!child.killed) child.kill("SIGTERM");
	}
}

function parseSearchPayload(text) {
	if (!text) return [];
	try {
		return JSON.parse(text);
	} catch {
		const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1]?.trim();
		if (fenced) return JSON.parse(fenced);
		const objectStart = text.indexOf("{");
		const arrayStart = text.indexOf("[");
		const start =
			objectStart < 0
				? arrayStart
				: arrayStart < 0
					? objectStart
					: Math.min(objectStart, arrayStart);
		const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
		if (start >= 0 && end > start)
			return JSON.parse(text.slice(start, end + 1));
		return [];
	}
}

function summarize(rows) {
	const metrics = [
		"totalMs",
		"initializeMs",
		"sessionMs",
		"promptMs",
		"parseMs",
	];
	return Object.fromEntries(
		metrics.map((metric) => [metric, stats(rows.map((row) => row[metric]))]),
	);
}

function stats(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		mean: Math.round(mean),
		min: Math.round(sorted[0]),
		p50: Math.round(sorted[Math.floor(sorted.length / 2)]),
		max: Math.round(sorted[sorted.length - 1]),
	};
}

function printHuman({ commandSettings, options, rows, summary }) {
	console.log(`Gemini ACP search benchmark`);
	console.log(
		`command: ${commandSettings.command} ${commandSettings.args.join(" ")}`,
	);
	console.log(`query: ${options.query}`);
	console.log(`runs: ${options.runs}`);
	console.log("");
	for (const row of rows) {
		console.log(
			`run ${row.run}: total=${Math.round(row.totalMs)}ms initialize=${Math.round(row.initializeMs)}ms session=${Math.round(row.sessionMs)}ms prompt=${Math.round(row.promptMs)}ms parse=${Math.round(row.parseMs)}ms results=${row.results} bytes=${row.bytes}`,
		);
	}
	console.log("");
	console.log("summary (ms):");
	for (const [metric, values] of Object.entries(summary)) {
		console.log(
			`  ${metric}: mean=${values.mean} p50=${values.p50} min=${values.min} max=${values.max}`,
		);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const commandSettings = await loadCommandSettings(options);
	const rows = [];
	for (let run = 1; run <= options.runs; run += 1) {
		const row = await measureRun({ ...options, ...commandSettings, run });
		rows.push(row);
		if (!options.json) {
			console.log(
				`completed run ${row.run}/${options.runs}: total=${Math.round(row.totalMs)}ms results=${row.results}`,
			);
		}
	}
	const result = {
		command: commandSettings.command,
		args: commandSettings.args,
		settingsPath: commandSettings.settingsPath,
		query: options.query,
		maxResults: options.maxResults,
		runs: rows,
		summary: summarize(rows),
	};
	if (options.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log("");
		printHuman({ commandSettings, options, rows, summary: result.summary });
	}
}

main().catch((error) => {
	console.error(
		`[bench-gemini-search] ERROR: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
