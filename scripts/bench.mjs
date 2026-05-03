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

Bench Gemini ACP search via JSON-RPC and report initialize/session/prompt/parse timings.

Options:
  --query <text>          Search query (default: ${DEFAULT_QUERY})
  --runs <n>              Number of measured search prompts (default: 3)
  --max-results <n>       Requested max search results (default: 5)
  --mode <fresh|warm|both>
                          fresh starts per run; warm reuses one session;
                          both runs fresh then warm (default: fresh)
  --settings <path>       Settings JSON path (default: ${DEFAULT_SETTINGS_PATH})
  --command <name|path>   Override configured ACP executable
  --arg <value>           Override ACP arg. Repeatable; replaces configured args.
  --timeout-ms <n>        Per-run timeout in milliseconds (default: 60000)
  --json                  Emit machine-readable JSON only
  -h, --help              Show this help

Examples:
  node scripts/bench.mjs
  node scripts/bench.mjs --runs 5 --query "Amsterdam weather"
  node scripts/bench.mjs --mode both --runs 2
  node scripts/bench.mjs --command gemini --arg --acp
`);
}

function parseArgs(argv) {
	const options = {
		query: DEFAULT_QUERY,
		runs: 3,
		maxResults: 5,
		mode: "fresh",
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
			case "--mode":
				options.mode = modeValue(value());
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

function modeValue(raw) {
	if (["fresh", "warm", "both"].includes(raw)) return raw;
	throw new Error("--mode must be fresh, warm, or both");
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

class BenchAcpSession {
	static start({ command, args, timeoutMs }) {
		const child = spawn(command, args, {
			cwd: PROJECT_DIR,
			env: process.env,
			stdio: "pipe",
		});
		return new BenchAcpSession(child, timeoutMs);
	}

	constructor(child, timeoutMs) {
		this.child = child;
		this.timeoutMs = timeoutMs;
		this.nextId = 1;
		this.stdoutBuffer = "";
		this.stderrBuffer = "";
		this.pending = new Map();
		this.chunks = [];
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.readStdout(chunk));
		child.stderr.on("data", (chunk) => {
			this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
		});
		child.on("error", (error) => this.rejectAll(error));
		child.on("exit", (code, signal) => {
			if (this.pending.size === 0) return;
			this.rejectAll(
				new Error(
					`Gemini ACP exited with ${signal ?? code}: ${this.stderrBuffer}`,
				),
			);
		});
	}

	async initialize() {
		await this.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "pi-gemini-acp-bench", version: "0.0.0" },
			clientCapabilities: { terminal: false },
		});
	}

	async newSession() {
		const session = await this.request("session/new", {
			cwd: PROJECT_DIR,
			mcpServers: [],
		});
		if (typeof session?.sessionId !== "string") {
			throw new Error("Gemini ACP did not return a sessionId");
		}
		return session.sessionId;
	}

	async prompt(sessionId, text) {
		this.chunks = [];
		await this.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text }],
		});
		return this.chunks.join("").trim();
	}

	close() {
		try {
			this.child.stdin.end();
		} catch {
			/* stdio may already be closed after failures */
		}
		if (!this.child.killed) this.child.kill("SIGTERM");
	}

	request(method, params) {
		const id = this.nextId;
		this.nextId += 1;
		const promise = new Promise((resolveRequest, rejectRequest) => {
			this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
		});
		const timeout = setTimeout(() => {
			this.child.kill("SIGTERM");
			this.rejectAll(new Error(`Timed out after ${this.timeoutMs}ms`));
		}, this.timeoutMs);
		promise.then(
			() => clearTimeout(timeout),
			() => clearTimeout(timeout),
		);
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
		return promise;
	}

	readStdout(chunk) {
		this.stdoutBuffer += chunk;
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line) this.handleMessage(JSON.parse(line));
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	handleMessage(message) {
		if (message.id !== undefined && message.method) {
			this.respondToAgentRequest(message);
			return;
		}
		if (message.method === "session/update") {
			const update = message.params?.update;
			if (
				update?.sessionUpdate === "agent_message_chunk" &&
				update.content?.type === "text" &&
				typeof update.content.text === "string"
			) {
				this.chunks.push(update.content.text);
			}
			return;
		}
		if (message.id === undefined) return;
		const pendingRequest = this.pending.get(message.id);
		if (!pendingRequest) return;
		this.pending.delete(message.id);
		if (message.error) {
			pendingRequest.reject(
				new Error(message.error.message ?? "Gemini ACP JSON-RPC error"),
			);
		} else {
			pendingRequest.resolve(message.result);
		}
	}

	respondToAgentRequest(message) {
		if (message.method === "session/request_permission") {
			this.respond(message.id, { outcome: { outcome: "cancelled" } });
			return;
		}
		this.respond(message.id, undefined, {
			code: -32601,
			message: `Method not found: ${message.method}`,
		});
	}

	respond(id, result, error) {
		this.child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`,
		);
	}

	rejectAll(error) {
		for (const pendingRequest of this.pending.values())
			pendingRequest.reject(error);
		this.pending.clear();
	}
}

async function runFreshBenchmark(options, commandSettings) {
	const rows = [];
	for (let run = 1; run <= options.runs; run += 1) {
		const row = await measureFreshRun({ ...options, ...commandSettings, run });
		rows.push(row);
		printProgress(options, "fresh", row);
	}
	return rows;
}

async function measureFreshRun({
	command,
	args,
	query,
	maxResults,
	timeoutMs,
	run,
}) {
	const totalStart = performance.now();
	const session = BenchAcpSession.start({ command, args, timeoutMs });
	try {
		const initializeStart = performance.now();
		await session.initialize();
		const initializeMs = performance.now() - initializeStart;
		const sessionStart = performance.now();
		const sessionId = await session.newSession();
		const sessionMs = performance.now() - sessionStart;
		const prompt = await measurePrompt(session, sessionId, query, maxResults);
		return {
			run,
			totalMs: performance.now() - totalStart,
			initializeMs,
			sessionMs,
			...prompt,
		};
	} finally {
		session.close();
	}
}

async function runWarmBenchmark(options, commandSettings) {
	const rows = [];
	const session = BenchAcpSession.start(commandSettings);
	try {
		const initializeStart = performance.now();
		await session.initialize();
		const initializeMs = performance.now() - initializeStart;
		const sessionStart = performance.now();
		const sessionId = await session.newSession();
		const sessionMs = performance.now() - sessionStart;
		for (let run = 1; run <= options.runs; run += 1) {
			const prompt = await measurePrompt(
				session,
				sessionId,
				options.query,
				options.maxResults,
			);
			const setupMs = run === 1 ? initializeMs + sessionMs : 0;
			const row = {
				run,
				totalMs: setupMs + prompt.promptMs + prompt.parseMs,
				initializeMs: run === 1 ? initializeMs : 0,
				sessionMs: run === 1 ? sessionMs : 0,
				...prompt,
			};
			rows.push(row);
			printProgress(options, "warm", row);
		}
		return rows;
	} finally {
		session.close();
	}
}

async function measurePrompt(session, sessionId, query, maxResults) {
	const promptStart = performance.now();
	const text = await session.prompt(
		sessionId,
		buildSearchPrompt(query, maxResults),
	);
	const promptMs = performance.now() - promptStart;
	const parseStart = performance.now();
	const parsed = parseSearchPayload(text);
	const parseMs = performance.now() - parseStart;
	return {
		promptMs,
		parseMs,
		results: Array.isArray(parsed) ? parsed.length : 0,
		bytes: text.length,
	};
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
	return Object.fromEntries(
		["totalMs", "initializeMs", "sessionMs", "promptMs", "parseMs"].map(
			(metric) => [metric, stats(rows.map((row) => row[metric]))],
		),
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

function printProgress(options, mode, row) {
	if (options.json) return;
	console.log(
		`completed ${mode} run ${row.run}/${options.runs}: total=${Math.round(row.totalMs)}ms results=${row.results}`,
	);
}

function printHuman({ commandSettings, options, sections }) {
	console.log(`\nGemini ACP search benchmark`);
	console.log(
		`command: ${commandSettings.command} ${commandSettings.args.join(" ")}`,
	);
	console.log(`query: ${options.query}`);
	console.log(`runs: ${options.runs}`);
	for (const section of sections) {
		console.log(`\nmode: ${section.mode}`);
		for (const row of section.runs) {
			console.log(
				`run ${row.run}: total=${Math.round(row.totalMs)}ms initialize=${Math.round(row.initializeMs)}ms session=${Math.round(row.sessionMs)}ms prompt=${Math.round(row.promptMs)}ms parse=${Math.round(row.parseMs)}ms results=${row.results} bytes=${row.bytes}`,
			);
		}
		console.log("summary (ms):");
		for (const [metric, values] of Object.entries(section.summary)) {
			console.log(
				`  ${metric}: mean=${values.mean} p50=${values.p50} min=${values.min} max=${values.max}`,
			);
		}
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const commandSettings = await loadCommandSettings(options);
	const sections = [];
	if (options.mode === "fresh" || options.mode === "both") {
		const runs = await runFreshBenchmark(options, commandSettings);
		sections.push({ mode: "fresh", runs, summary: summarize(runs) });
	}
	if (options.mode === "warm" || options.mode === "both") {
		const runs = await runWarmBenchmark(options, {
			...commandSettings,
			timeoutMs: options.timeoutMs,
		});
		sections.push({ mode: "warm", runs, summary: summarize(runs) });
	}
	const result = {
		command: commandSettings.command,
		args: commandSettings.args,
		settingsPath: commandSettings.settingsPath,
		query: options.query,
		maxResults: options.maxResults,
		mode: options.mode,
		sections,
	};
	if (options.json) console.log(JSON.stringify(result, null, 2));
	else printHuman({ commandSettings, options, sections });
}

main().catch((error) => {
	console.error(
		`[bench-gemini-search] ERROR: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
