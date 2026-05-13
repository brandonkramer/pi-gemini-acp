#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { JsonRpcResponseError, JsonRpcStdioClient } from "../src/acp/jsonrpc-stdio.ts";
import { searchPrompt } from "../src/acp/search-prompt.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_SETTINGS_PATH = join(homedir(), ".pi", "gemini-acp", "config", "settings.json");
const DEFAULT_QUERY = "Amsterdam Netherlands current weather temperature conditions";
const DEFAULT_CHAT_PROMPT =
	"In one paragraph, describe what makes Amsterdam architecturally distinctive.";
const DEFAULT_MODE = "warm";
const DEFAULT_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const PROMPT_VARIANTS = ["current", "short-json", "web-json"];
const BENCH_KINDS = ["search", "chat"];

function usage() {
	console.log(`Usage: node scripts/bench.mjs [options]

Bench Gemini ACP via JSON-RPC. Default kind is search; --bench chat measures
TTFT, end-to-end, and approximate tokens/sec for a chat-style turn.

Options:
  --bench <search|chat>   What to benchmark (default: search)
  --query <text>          Search query (default: ${DEFAULT_QUERY})
  --chat-prompt <text>    Chat prompt for --bench chat (default: a short Amsterdam prompt)
  --runs <n>              Runs per section (default: ${DEFAULT_RUNS}; parallel default: 1)
  --batches <n>           Repeat the benchmark suite N times (default: 1)
  --max-results <n>       Requested max search results (default: 5)
  --lower-max-results <n> Lower max-results used by --suite variants (default: 2)
  --mode <fresh|warm|both|parallel>
                          fresh starts per run; warm reuses one session;
                          both runs fresh then warm; parallel starts independent
                          fresh sessions concurrently (default: ${DEFAULT_MODE};
                          --bench chat supports fresh/warm/both only)
  --prompt-variant <current|short-json|web-json|all>
                          Search prompt shape (default: current; ignored for chat)
  --suite <variants>      Run current/short-json/web-json plus lower max-results cases
  --parallel-queries <q1|q2|q3>
                          Pipe-delimited queries for --mode parallel
  --settings <path>       Settings JSON path (default: ${DEFAULT_SETTINGS_PATH})
  --command <name|path>   Override configured ACP executable
  --arg <value>           Override ACP arg. Repeatable; replaces configured args.
  --timeout-ms <n>        Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --history-turns <n>     Simulate N prior back-and-forth turns before the measured chat prompt
                          (default: 0; chat bench only)
  --json                  Emit machine-readable JSON only
  -h, --help              Show this help

Examples:
  node scripts/bench.mjs
  node scripts/bench.mjs --bench chat --runs 5
  node scripts/bench.mjs --bench chat --mode both --chat-prompt "Summarize TLS 1.3 in two sentences."
  node scripts/bench.mjs --bench chat --mode warm --history-turns 10 --runs 3
  node scripts/bench.mjs --runs 5 --query "Amsterdam weather"
  node scripts/bench.mjs --mode both --prompt-variant all --runs 1
  node scripts/bench.mjs --suite variants --mode warm --runs 1
  node scripts/bench.mjs --mode parallel --parallel-queries "Amsterdam weather|London weather|Berlin weather" --max-results 2
  node scripts/bench.mjs --command gemini --arg --acp
`);
}

function parseArgs(argv) {
	const options = {
		bench: "search",
		query: DEFAULT_QUERY,
		chatPrompt: DEFAULT_CHAT_PROMPT,
		runs: undefined,
		batches: 1,
		maxResults: 5,
		lowerMaxResults: 2,
		mode: DEFAULT_MODE,
		promptVariant: "current",
		suite: undefined,
		parallelQueries: [],
		settingsPath: DEFAULT_SETTINGS_PATH,
		command: undefined,
		args: undefined,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		historyTurns: 0,
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
			case "--bench":
				options.bench = benchKindValue(value());
				break;
			case "--chat-prompt":
				options.chatPrompt = value();
				break;
			case "--query":
				options.query = value();
				break;
			case "--runs":
				options.runs = positiveInteger(value(), "--runs");
				break;
			case "--batches":
				options.batches = positiveInteger(value(), "--batches");
				break;
			case "--max-results":
				options.maxResults = positiveInteger(value(), "--max-results");
				break;
			case "--lower-max-results":
				options.lowerMaxResults = positiveInteger(value(), "--lower-max-results");
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
			case "--history-turns":
				options.historyTurns = nonNegativeInteger(value(), "--history-turns");
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
	options.runs ??= options.mode === "parallel" ? 1 : DEFAULT_RUNS;
	if (options.mode === "parallel" && options.parallelQueries.length === 0) {
		options.parallelQueries = [options.query];
	}
	if (options.bench === "chat" && options.mode === "parallel") {
		throw new Error("--bench chat does not support --mode parallel");
	}
	return options;
}

function benchKindValue(raw) {
	if (BENCH_KINDS.includes(raw)) return raw;
	throw new Error(`--bench must be one of: ${BENCH_KINDS.join(", ")}`);
}

function positiveInteger(raw, flag) {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return value;
}

function nonNegativeInteger(raw, flag) {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${flag} must be a non-negative integer`);
	}
	return value;
}

function modeValue(raw) {
	if (["fresh", "warm", "both", "parallel"].includes(raw)) return raw;
	throw new Error("--mode must be fresh, warm, both, or parallel");
}

function promptVariantValue(raw) {
	if ([...PROMPT_VARIANTS, "all"].includes(raw)) return raw;
	throw new Error("--prompt-variant must be current, short-json, web-json, or all");
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
	if (queries.length === 0) throw new Error("--parallel-queries must include at least one query");
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
	const variants = options.promptVariant === "all" ? PROMPT_VARIANTS : [options.promptVariant];
	return variants.map((variant) => benchCase(options, variant, options.maxResults));
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
			return searchPrompt({ query, maxResults });
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
		this.timeoutMs = timeoutMs;
		this.chunks = [];
		this.firstChunkAt = null;
		this.rpc = new JsonRpcStdioClient(child, {
			onRequest: (message) => this.respondToAgentRequest(message),
			onNotification: (message) => this.collectNotification(message),
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
		this.firstChunkAt = null;
		await this.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text }],
		});
		return this.chunks.join("").trim();
	}

	close() {
		void this.rpc.close();
	}

	request(method, params) {
		return this.rpc.request(method, params, { timeoutMs: this.timeoutMs });
	}

	collectNotification(message) {
		if (message.method !== "session/update") return;
		const update = message.params?.update;
		if (
			update?.sessionUpdate === "agent_message_chunk" &&
			update.content?.type === "text" &&
			typeof update.content.text === "string"
		) {
			if (this.firstChunkAt === null) this.firstChunkAt = performance.now();
			this.chunks.push(update.content.text);
		}
	}

	respondToAgentRequest(message) {
		if (message.method === "session/request_permission") {
			return { outcome: { outcome: "cancelled" } };
		}
		throw new JsonRpcResponseError(-32601, `Method not found: ${message.method}`);
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
		const prompt = await measurePrompt(session, sessionId, query, maxResults, promptVariant);
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

async function runChatBenchmark(options, commandSettings) {
	const sections = [];
	if (options.mode === "fresh" || options.mode === "both") {
		const rows = [];
		for (let run = 1; run <= options.runs; run += 1) {
			const row = await measureFreshChatRun({ ...options, ...commandSettings, run });
			rows.push(row);
			printChatProgress(options, "fresh", row);
		}
		sections.push(chatSection("fresh", options, rows));
	}
	if (options.mode === "warm" || options.mode === "both") {
		const session = BenchAcpSession.start({ ...commandSettings, timeoutMs: options.timeoutMs });
		try {
			const initializeStart = performance.now();
			await session.initialize();
			const initializeMs = performance.now() - initializeStart;
			const sessionStart = performance.now();
			const sessionId = await session.newSession();
			const sessionMs = performance.now() - sessionStart;
			if (options.historyTurns > 0) {
				await seedChatHistory(session, sessionId, options.historyTurns);
			}
			const rows = [];
			for (let run = 1; run <= options.runs; run += 1) {
				const prompt = await measureChatPrompt(
					session,
					sessionId,
					options.chatPrompt,
					options.historyTurns,
				);
				const setupMs = run === 1 ? initializeMs + sessionMs : 0;
				const row = {
					run,
					chatPrompt: options.chatPrompt,
					totalMs: setupMs + prompt.promptMs,
					initializeMs: run === 1 ? initializeMs : 0,
					sessionMs: run === 1 ? sessionMs : 0,
					...prompt,
				};
				rows.push(row);
				printChatProgress(options, "warm", row);
			}
			sections.push(chatSection("warm", options, rows));
		} finally {
			session.close();
		}
	}
	return sections;
}

async function measureFreshChatRun({ command, args, chatPrompt, timeoutMs, run, historyTurns }) {
	const totalStart = performance.now();
	const session = BenchAcpSession.start({ command, args, timeoutMs });
	try {
		const initializeStart = performance.now();
		await session.initialize();
		const initializeMs = performance.now() - initializeStart;
		const sessionStart = performance.now();
		const sessionId = await session.newSession();
		const sessionMs = performance.now() - sessionStart;
		if (historyTurns > 0) {
			await seedChatHistory(session, sessionId, historyTurns);
		}
		const prompt = await measureChatPrompt(session, sessionId, chatPrompt, historyTurns);
		return {
			run,
			chatPrompt,
			totalMs: performance.now() - totalStart,
			initializeMs,
			sessionMs,
			...prompt,
		};
	} finally {
		session.close();
	}
}

async function seedChatHistory(session, sessionId, turns) {
	for (let i = 0; i < turns; i += 1) {
		await session.prompt(sessionId, `Bench history turn ${i + 1}: what is 2+2?`);
	}
}

function chatSection(mode, options, rows) {
	return {
		bench: "chat",
		mode,
		chatPrompt: options.chatPrompt,
		runs: rows,
		summary: summarize(rows),
	};
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
		summary: summarize(batches.map((batch) => ({ totalMs: batch.wallClockMs }))),
	};
}

async function measurePrompt(session, sessionId, query, maxResults, promptVariant) {
	const promptStart = performance.now();
	const text = await session.prompt(sessionId, buildSearchPrompt(query, maxResults, promptVariant));
	const promptMs = performance.now() - promptStart;
	const ttftMs = session.firstChunkAt !== null ? session.firstChunkAt - promptStart : null;
	const parseStart = performance.now();
	const parsed = parseSearchPayload(text);
	const parseMs = performance.now() - parseStart;
	return {
		promptMs,
		ttftMs,
		parseMs,
		results: Array.isArray(parsed) ? parsed.length : 0,
		bytes: text.length,
	};
}

function buildSimulatedHistory(turns) {
	const userMsg = `Can you explain the key differences between REST and GraphQL API design patterns, including trade-offs around caching, versioning, and real-time capabilities?`;
	const assistantMsg = `REST uses fixed endpoints and HTTP verbs, making it simple and cache-friendly but can lead to over-fetching. GraphQL lets clients request exactly the fields they need via a single endpoint, which reduces bandwidth but complicates caching because responses vary by query. REST versioning typically lives in the URL or headers; GraphQL avoids versioning by evolving schemas and deprecating fields. For real-time, REST needs WebSockets or polling, while GraphQL has subscriptions built into the spec. In practice, many teams use REST for public APIs and GraphQL for internal or mobile clients where payload size matters.`;
	let history = "";
	for (let i = 0; i < turns; i += 1) {
		history += `User: ${userMsg}\nAssistant: ${assistantMsg}\n`;
	}
	return history;
}

async function measureChatPrompt(session, sessionId, chatPrompt, historyTurns = 0) {
	const promptStart = performance.now();
	const fullPrompt =
		historyTurns > 0 ? buildSimulatedHistory(historyTurns) + chatPrompt : chatPrompt;
	const text = await session.prompt(sessionId, fullPrompt);
	const promptMs = performance.now() - promptStart;
	const ttftMs = session.firstChunkAt !== null ? session.firstChunkAt - promptStart : null;
	const chars = text.length;
	// chars/4 matches the runtime cost estimator's approximation (src/tools/cost-estimate.ts).
	const approxTokens = Math.max(1, Math.ceil(chars / 4));
	const streamMs = ttftMs !== null ? Math.max(1, promptMs - ttftMs) : promptMs;
	const tokensPerSec = streamMs > 0 ? Math.round((approxTokens / streamMs) * 1000) : null;
	return {
		promptMs,
		ttftMs,
		chars,
		approxTokens,
		tokensPerSec,
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
		"ttftMs",
		"parseMs",
		"approxTokens",
		"tokensPerSec",
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
	const batchLabel = options.batches > 1 ? ` batch ${options.batch}/${options.batches}` : "";
	console.log(
		`completed ${mode} ${bench.label}${batchLabel} run ${row.run}/${options.runs}: total=${Math.round(row.totalMs)}ms results=${row.results}`,
	);
}

function printChatProgress(options, mode, row) {
	if (options.json) return;
	const ttft = row.ttftMs !== null ? `${Math.round(row.ttftMs)}ms` : "n/a";
	console.log(
		`completed chat ${mode} run ${row.run}/${options.runs}: total=${Math.round(row.totalMs)}ms ttft=${ttft} tokens≈${row.approxTokens} tok/s≈${row.tokensPerSec ?? "n/a"}`,
	);
}

function printParallelProgress(options, bench, batch) {
	if (options.json) return;
	const batchLabel = options.batches > 1 ? ` suite ${options.batch}/${options.batches}` : "";
	console.log(
		`completed parallel ${bench.label}${batchLabel} batch ${batch.run}/${options.runs}: wall=${Math.round(batch.wallClockMs)}ms queries=${batch.queries.length}`,
	);
}

function printHuman({ commandSettings, options, sections }) {
	console.log(`\nGemini ACP ${options.bench} benchmark`);
	console.log(`command: ${commandSettings.command} ${commandSettings.args.join(" ")}`);
	console.log(`runs: ${options.runs}`);
	console.log(`batches: ${options.batches}`);
	for (const item of sections) {
		if (item.bench === "chat") printChatSection(item);
		else if (item.mode === "parallel") printParallelSection(item);
		else printPromptSection(item);
	}
	if (options.batches > 1) printBatchAggregate(sections);
}

function printChatSection(item) {
	const batchLabel = item.batch ? `; batch: ${item.batch}` : "";
	console.log(`\nbench: chat; mode: ${item.mode}${batchLabel}; prompt: ${item.chatPrompt}`);
	for (const row of item.runs) {
		const ttft = row.ttftMs !== null ? `${Math.round(row.ttftMs)}ms` : "n/a";
		console.log(
			`run ${row.run}: total=${Math.round(row.totalMs)}ms initialize=${Math.round(row.initializeMs)}ms session=${Math.round(row.sessionMs)}ms prompt=${Math.round(row.promptMs)}ms ttft=${ttft} chars=${row.chars} tokens≈${row.approxTokens} tok/s≈${row.tokensPerSec ?? "n/a"}`,
		);
	}
	printSummary(item.summary);
}

function printPromptSection(item) {
	const batchLabel = item.batch ? `; batch: ${item.batch}` : "";
	console.log(
		`\nmode: ${item.mode}${batchLabel}; variant: ${item.promptVariant}; maxResults: ${item.maxResults}; query: ${item.query}`,
	);
	for (const row of item.runs) {
		console.log(
			`run ${row.run}: total=${Math.round(row.totalMs)}ms initialize=${Math.round(row.initializeMs)}ms session=${Math.round(row.sessionMs)}ms prompt=${Math.round(row.promptMs)}ms parse=${Math.round(row.parseMs)}ms results=${row.results} bytes=${row.bytes}`,
		);
	}
	printSummary(item.summary);
}

function printParallelSection(item) {
	const batchLabel = item.batch ? `; suite batch: ${item.batch}` : "";
	console.log(
		`\nmode: parallel${batchLabel}; variant: ${item.promptVariant}; maxResults: ${item.maxResults}; queries: ${item.queries.join(" | ")}`,
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

function printBatchAggregate(sections) {
	console.log("\naggregate across batches (ms; compare p50 first):");
	for (const item of aggregateSections(sections)) {
		console.log(
			`${item.key}: totalMs p50=${item.summary.totalMs.p50} mean=${item.summary.totalMs.mean} min=${item.summary.totalMs.min} max=${item.summary.totalMs.max}`,
		);
	}
}

function aggregateSections(sections) {
	const groups = new Map();
	for (const item of sections) {
		const key =
			item.bench === "chat"
				? `chat/${item.mode}`
				: `${item.mode}/${item.promptVariant}/max${item.maxResults}`;
		const rows = groups.get(key) ?? [];
		if (item.mode === "parallel") {
			rows.push(...item.runs.map((batch) => ({ totalMs: batch.wallClockMs })));
		} else {
			rows.push(...item.runs);
		}
		groups.set(key, rows);
	}
	return [...groups.entries()].map(([key, rows]) => ({
		key,
		summary: summarize(rows),
	}));
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const commandSettings = await loadCommandSettings(options);
	const sections = [];
	if (options.bench === "chat") {
		for (let batch = 1; batch <= options.batches; batch += 1) {
			const batchOptions = { ...options, batch };
			const chatSections = await runChatBenchmark(batchOptions, commandSettings);
			for (const item of chatSections) {
				sections.push({ ...item, batch: options.batches > 1 ? batch : undefined });
			}
		}
		const result = {
			bench: "chat",
			command: commandSettings.command,
			args: commandSettings.args,
			settingsPath: commandSettings.settingsPath,
			mode: options.mode,
			chatPrompt: options.chatPrompt,
			batches: options.batches,
			sections,
		};
		if (options.json) console.log(JSON.stringify(result, null, 2));
		else printHuman({ commandSettings, options, sections });
		return;
	}
	for (let batch = 1; batch <= options.batches; batch += 1) {
		const batchOptions = { ...options, batch };
		for (const item of benchmarkCases(options)) {
			if (options.mode === "fresh" || options.mode === "both") {
				sections.push({
					...(await runFreshBenchmark(batchOptions, commandSettings, item)),
					batch: options.batches > 1 ? batch : undefined,
				});
			}
			if (options.mode === "warm" || options.mode === "both") {
				sections.push({
					...(await runWarmBenchmark(batchOptions, commandSettings, item)),
					batch: options.batches > 1 ? batch : undefined,
				});
			}
			if (options.mode === "parallel") {
				sections.push({
					...(await runParallelBenchmark(batchOptions, commandSettings, item)),
					batch: options.batches > 1 ? batch : undefined,
				});
			}
		}
	}
	const result = {
		command: commandSettings.command,
		args: commandSettings.args,
		settingsPath: commandSettings.settingsPath,
		mode: options.mode,
		promptVariant: options.promptVariant,
		maxResults: options.maxResults,
		batches: options.batches,
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
