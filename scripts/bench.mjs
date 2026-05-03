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
const PROMPT_VARIANTS = ["current", "short-json", "web-json"];

function usage() {
	console.log(`Usage: node scripts/bench.mjs [options]

Bench Gemini ACP search via JSON-RPC and report initialize/session/prompt/parse timings.

Options:
  --query <text>          Search query (default: ${DEFAULT_QUERY})
  --runs <n>              Runs per section (default: 3; parallel default: 1)
  --max-results <n>       Requested max search results (default: 5)
  --lower-max-results <n> Lower max-results used by --suite variants (default: 2)
  --mode <fresh|warm|both|parallel>
                          fresh starts per run; warm reuses one session;
                          both runs fresh then warm; parallel starts independent
                          fresh sessions concurrently (default: fresh)
  --prompt-variant <current|short-json|web-json|all>
                          Prompt shape to benchmark (default: current)
  --suite <variants>      Run current/short-json/web-json plus lower max-results cases
  --parallel-queries <q1|q2|q3>
                          Pipe-delimited queries for --mode parallel
  --settings <path>       Settings JSON path (default: ${DEFAULT_SETTINGS_PATH})
  --command <name|path>   Override configured ACP executable
  --arg <value>           Override ACP arg. Repeatable; replaces configured args.
  --timeout-ms <n>        Per-request timeout in milliseconds (default: 60000)
  --json                  Emit machine-readable JSON only
  -h, --help              Show this help

Examples:
  node scripts/bench.mjs
  node scripts/bench.mjs --runs 5 --query "Amsterdam weather"
  node scripts/bench.mjs --mode both --prompt-variant all --runs 1
  node scripts/bench.mjs --suite variants --mode warm --runs 1
  node scripts/bench.mjs --mode parallel --parallel-queries "Amsterdam weather|London weather|Berlin weather" --max-results 2
  node scripts/bench.mjs --command gemini --arg --acp
`);
}

function parseArgs(argv) {
	const options = {
		query: DEFAULT_QUERY,
		runs: undefined,
		maxResults: 5,
		lowerMaxResults: 2,
		mode: "fresh",
		promptVariant: "current",
		suite: undefined,
		parallelQueries: [],
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
			case "--lower-max-results":
				options.lowerMaxResults = positiveInteger(
					value(),
					"--lower-max-results",
				);
				break;
			case "--mode":
				options.mode = modeValue(value());
				break;
			case "--prompt-variant":
				options.promptVariant = promptVariantValue(value());
				break;
			case "--suite":
				options.suite = suiteValue(value());
				break;
			case "--parallel-queries":
				options.parallelQueries = splitQueries(value());
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
	options.runs ??= options.mode === "parallel" ? 1 : 3;
	if (options.mode === "parallel" && options.parallelQueries.length === 0) {
		options.parallelQueries = [options.query];
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
	if (["fresh", "warm", "both", "parallel"].includes(raw)) return raw;
	throw new Error("--mode must be fresh, warm, both, or parallel");
}

function promptVariantValue(raw) {
	if ([...PROMPT_VARIANTS, "all"].includes(raw)) return raw;
	throw new Error(
		"--prompt-variant must be current, short-json, web-json, or all",
	);
}

function suiteValue(raw) {
	if (raw === "variants") return raw;
	throw new Error("--suite must be variants");
}

function splitQueries(raw) {
	const queries = raw
		.split("|")
		.map((query) => query.trim())
		.filter(Boolean);
	if (queries.length === 0)
		throw new Error("--parallel-queries must include at least one query");
	return queries;
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

function benchmarkCases(options) {
	if (options.suite === "variants") {
		return [
			benchCase(options, "current", options.maxResults),
			benchCase(options, "short-json", options.maxResults),
			benchCase(options, "current", options.lowerMaxResults),
			benchCase(options, "short-json", options.lowerMaxResults),
			benchCase(options, "web-json", options.maxResults),
		];
	}
	const variants =
		options.promptVariant === "all" ? PROMPT_VARIANTS : [options.promptVariant];
	return variants.map((variant) =>
		benchCase(options, variant, options.maxResults),
	);
}

function benchCase(options, promptVariant, maxResults) {
	return {
		query: options.query,
		promptVariant,
		maxResults,
		label: `${promptVariant}/max${maxResults}`,
	};
}

function buildSearchPrompt(query, maxResults, variant) {
	switch (variant) {
		case "current":
			return [
				`Run a grounded web search for: ${query}`,
				`Return up to ${maxResults} results as JSON only.`,
				'Use this exact shape: [{"title": string, "url": string, "snippet": string}]',
				"Do not include Markdown fences or explanatory text.",
			].join("\n");
		case "short-json":
			return `Search web: ${query}\nReturn JSON array only, max ${maxResults}: [{"title":string,"url":string,"snippet":string}]`;
		case "web-json":
			return `/web ${query}\nReturn JSON array only, max ${maxResults}: [{"title":string,"url":string,"snippet":string}]`;
		default:
			throw new Error(`Unknown prompt variant: ${variant}`);
	}
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
		for (const pendingRequest of this.pending.values()) {
			pendingRequest.reject(error);
		}
		this.pending.clear();
	}
}

async function runFreshBenchmark(options, commandSettings, bench) {
	const rows = [];
	for (let run = 1; run <= options.runs; run += 1) {
		const row = await measureFreshRun({
			...options,
			...commandSettings,
			...bench,
			run,
		});
		rows.push(row);
		printProgress(options, "fresh", bench, row);
	}
	return section("fresh", bench, rows);
}

async function measureFreshRun({
	command,
	args,
	query,
	maxResults,
	promptVariant,
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
		const prompt = await measurePrompt(
			session,
			sessionId,
			query,
			maxResults,
			promptVariant,
		);
		return {
			run,
			query,
			promptVariant,
			maxResults,
			totalMs: performance.now() - totalStart,
			initializeMs,
			sessionMs,
			...prompt,
		};
	} finally {
		session.close();
	}
}

async function runWarmBenchmark(options, commandSettings, bench) {
	const rows = [];
	const session = BenchAcpSession.start({
		...commandSettings,
		timeoutMs: options.timeoutMs,
	});
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
				bench.query,
				bench.maxResults,
				bench.promptVariant,
			);
			const setupMs = run === 1 ? initializeMs + sessionMs : 0;
			const row = {
				run,
				query: bench.query,
				promptVariant: bench.promptVariant,
				maxResults: bench.maxResults,
				totalMs: setupMs + prompt.promptMs + prompt.parseMs,
				initializeMs: run === 1 ? initializeMs : 0,
				sessionMs: run === 1 ? sessionMs : 0,
				...prompt,
			};
			rows.push(row);
			printProgress(options, "warm", bench, row);
		}
		return section("warm", bench, rows);
	} finally {
		session.close();
	}
}

async function runParallelBenchmark(options, commandSettings, bench) {
	const batches = [];
	for (let run = 1; run <= options.runs; run += 1) {
		const wallStart = performance.now();
		const queryRows = await Promise.all(
			options.parallelQueries.map((query, index) =>
				measureFreshRun({
					...options,
					...commandSettings,
					query,
					maxResults: bench.maxResults,
					promptVariant: bench.promptVariant,
					run: index + 1,
				}),
			),
		);
		const batch = {
			run,
			wallClockMs: performance.now() - wallStart,
			queries: queryRows,
		};
		batches.push(batch);
		printParallelProgress(options, bench, batch);
	}
	return {
		mode: "parallel",
		query: options.parallelQueries.join(" | "),
		queries: options.parallelQueries,
		promptVariant: bench.promptVariant,
		maxResults: bench.maxResults,
		runs: batches,
		summary: summarize(
			batches.map((batch) => ({ totalMs: batch.wallClockMs })),
		),
	};
}

async function measurePrompt(
	session,
	sessionId,
	query,
	maxResults,
	promptVariant,
) {
	const promptStart = performance.now();
	const text = await session.prompt(
		sessionId,
		buildSearchPrompt(query, maxResults, promptVariant),
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
		if (start >= 0 && end > start) {
			return JSON.parse(text.slice(start, end + 1));
		}
		return [];
	}
}

function section(mode, bench, runs) {
	return {
		mode,
		query: bench.query,
		promptVariant: bench.promptVariant,
		maxResults: bench.maxResults,
		runs,
		summary: summarize(runs),
	};
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
		metrics
			.filter((metric) => rows.every((row) => typeof row[metric] === "number"))
			.map((metric) => [metric, stats(rows.map((row) => row[metric]))]),
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

function printProgress(options, mode, bench, row) {
	if (options.json) return;
	console.log(
		`completed ${mode} ${bench.label} run ${row.run}/${options.runs}: total=${Math.round(row.totalMs)}ms results=${row.results}`,
	);
}

function printParallelProgress(options, bench, batch) {
	if (options.json) return;
	console.log(
		`completed parallel ${bench.label} batch ${batch.run}/${options.runs}: wall=${Math.round(batch.wallClockMs)}ms queries=${batch.queries.length}`,
	);
}

function printHuman({ commandSettings, options, sections }) {
	console.log(`\nGemini ACP search benchmark`);
	console.log(
		`command: ${commandSettings.command} ${commandSettings.args.join(" ")}`,
	);
	console.log(`runs: ${options.runs}`);
	for (const item of sections) {
		if (item.mode === "parallel") printParallelSection(item);
		else printPromptSection(item);
	}
}

function printPromptSection(item) {
	console.log(
		`\nmode: ${item.mode}; variant: ${item.promptVariant}; maxResults: ${item.maxResults}; query: ${item.query}`,
	);
	for (const row of item.runs) {
		console.log(
			`run ${row.run}: total=${Math.round(row.totalMs)}ms initialize=${Math.round(row.initializeMs)}ms session=${Math.round(row.sessionMs)}ms prompt=${Math.round(row.promptMs)}ms parse=${Math.round(row.parseMs)}ms results=${row.results} bytes=${row.bytes}`,
		);
	}
	printSummary(item.summary);
}

function printParallelSection(item) {
	console.log(
		`\nmode: parallel; variant: ${item.promptVariant}; maxResults: ${item.maxResults}; queries: ${item.queries.join(" | ")}`,
	);
	for (const batch of item.runs) {
		console.log(`batch ${batch.run}: wall=${Math.round(batch.wallClockMs)}ms`);
		for (const row of batch.queries) {
			console.log(
				`  ${row.query}: total=${Math.round(row.totalMs)}ms initialize=${Math.round(row.initializeMs)}ms session=${Math.round(row.sessionMs)}ms prompt=${Math.round(row.promptMs)}ms results=${row.results} bytes=${row.bytes}`,
			);
		}
	}
	console.log("summary wall-clock (ms):");
	for (const [metric, values] of Object.entries(item.summary)) {
		console.log(
			`  ${metric}: mean=${values.mean} p50=${values.p50} min=${values.min} max=${values.max}`,
		);
	}
}

function printSummary(summary) {
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
	const sections = [];
	for (const item of benchmarkCases(options)) {
		if (options.mode === "fresh" || options.mode === "both") {
			sections.push(await runFreshBenchmark(options, commandSettings, item));
		}
		if (options.mode === "warm" || options.mode === "both") {
			sections.push(await runWarmBenchmark(options, commandSettings, item));
		}
		if (options.mode === "parallel") {
			sections.push(await runParallelBenchmark(options, commandSettings, item));
		}
	}
	const result = {
		command: commandSettings.command,
		args: commandSettings.args,
		settingsPath: commandSettings.settingsPath,
		mode: options.mode,
		promptVariant: options.promptVariant,
		maxResults: options.maxResults,
		suite: options.suite,
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
