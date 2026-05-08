#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-gemini-natural-tool-use.XXXXXX")
KEEP_OUTPUT=0
for arg in "$@"; do
	if [[ "${arg}" == "--keep-output" ]]; then
		KEEP_OUTPUT=1
	fi
done
cleanup() {
	if [[ "${KEEP_OUTPUT}" == "1" ]]; then
		echo "[eval] kept output in ${TMP_DIR}"
	else
		rm -rf "${TMP_DIR}"
	fi
}
trap cleanup EXIT

DIST_DIR="${TMP_DIR}/dist"
MOCK_EXTENSION="${TMP_DIR}/gemini-tool-use-eval-extension.mjs"

cd "${ROOT_DIR}"
command -v pi >/dev/null 2>&1 || {
	echo "[eval] ERROR: pi CLI not found on PATH" >&2
	exit 1
}

npx tsc -p tsconfig.json \
	--rootDir src \
	--outDir "${DIST_DIR}" \
	--noEmit false \
	--declaration false \
	--sourceMap false >/dev/null
ln -s "${ROOT_DIR}/node_modules" "${TMP_DIR}/node_modules"

REGISTER_URL=$(
	node --input-type=module - "${DIST_DIR}/tools/register.js" <<'NODE'
import { pathToFileURL } from "node:url";
console.log(pathToFileURL(process.argv[2]).href);
NODE
)

node --input-type=module - "${REGISTER_URL}" "${MOCK_EXTENSION}" <<'NODE'
import { writeFileSync } from "node:fs";

const [registerUrl, mockExtension] = process.argv.slice(2);
writeFileSync(
	mockExtension,
	`import { geminiAcpTools } from ${JSON.stringify(registerUrl)};

export default function registerGeminiNaturalToolUseEval(pi) {
	for (const tool of geminiAcpTools) {
		pi.registerTool({
			...tool,
			execute: async (_toolCallId, params) => ({
				content: [
					{
						type: "text",
						text: \`EVAL_TOOL_CALLED \${tool.name}. Mock result complete; do not call another tool.\`,
					},
				],
				details: {
					data: {
						evalNaturalToolUse: true,
						tool: tool.name,
						arguments: params,
					},
				},
			}),
		});
	}
}
`,
);
NODE

node --input-type=module - "${MOCK_EXTENSION}" "${TMP_DIR}" "$@" <<'NODE'
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mockExtension, tmpDir, ...rawArgs] = process.argv.slice(2);

const cases = [
	{
		id: "status-ready",
		expected: ["gemini_status"],
		prompt: "Can you check whether Gemini ACP is configured and ready on this machine?",
	},
	{
		id: "status-auth",
		expected: ["gemini_status"],
		prompt: "Before I try Gemini search, is the local Gemini command authenticated and usable?",
	},
	{
		id: "summarize-text",
		expected: ["gemini_ask"],
		prompt:
			"Ask Gemini to summarize this in two short bullets: The city garden pilot added rain barrels, pollinator beds, and weekend compost training for apartment residents.",
	},
	{
		id: "extract-json",
		expected: ["gemini_ask"],
		prompt:
			"Ask Gemini to pull the order number, customer, and delivery window out as JSON: Order A-1842 for North Pier Coffee arrives Friday between 9am and 11am.",
	},
	{
		id: "review-diff",
		expected: ["gemini_ask"],
		prompt:
			"Ask Gemini to review this diff for correctness only.\n```diff\n-export const total = a - b;\n+export const total = a + b;\n```",
	},
	{
		id: "translate-copy",
		expected: ["gemini_ask"],
		prompt:
			"Ask Gemini to translate this product copy into Spanish and keep 'North Pier' unchanged: North Pier delivers fresh pastries before sunrise.",
	},
	{
		id: "search-this",
		expected: ["gemini_search"],
		prompt: "Search this: current SQLite vector extension docs and examples.",
	},
	{
		id: "search-local-notes",
		expected: ["gemini_search"],
		prompt:
			"Search these local notes for what the launch checklist says: staging passed smoke tests, the release owner is Maya, and rollback uses the blue deployment.",
	},
	{
		id: "research-this",
		expected: ["gemini_research"],
		prompt: "Research this with sources and citations: what are the current tradeoffs of small modular nuclear reactors for grid reliability?",
	},
	{
		id: "research-compare",
		expected: ["gemini_research"],
		prompt: "Look into heat pump water heaters versus tankless gas systems and bring back cited findings, not just a quick search result.",
	},
	{
		id: "analyze-file",
		expected: ["gemini_analyze"],
		prompt: "Analyze README.md with Gemini and tell me what provider setup it documents.",
	},
	{
		id: "describe-image",
		expected: ["gemini_analyze"],
		prompt: "Describe the screenshot at ./fixtures/status-screen.png and mention any visible errors.",
	},
	{
		id: "get-result",
		expected: ["gemini_results"],
		prompt: "Pull up the stored Gemini result with responseId 435aa138-4627-42c9-94e4-cbff93eb27bf.",
	},
	{
		id: "recall-results",
		expected: ["gemini_results"],
		prompt: "Search prior Gemini results for notes about grounding availability and preflight failures.",
	},
	{
		id: "negative-simple-math",
		expected: [],
		prompt: "What is 2 + 2? Answer directly.",
	},
	{
		id: "negative-smalltalk",
		expected: [],
		prompt: "Say hello in one short sentence without using any tools.",
	},
];

const usage = `Usage: eval/natural_tool_use.sh [options]

Runs Pi in non-interactive JSON mode with the real gemini_* tool surface and
mock execute handlers, then checks whether the LLM naturally selected the
expected tool for natural user prompts. No Gemini ACP provider calls are made.

Options:
  --model <pattern>       Pass --model to pi (or set PI_EVAL_MODEL)
  --provider <name>       Pass --provider to pi (or set PI_EVAL_PROVIDER)
  --case <substring>      Run only cases whose id contains substring
  --max-cases <n>         Run at most n matching cases
  --timeout <seconds>     Per-case timeout (default: 120; env PI_EVAL_TIMEOUT)
  --keep-output           Keep raw JSONL outputs in the temp directory
  --list                  List cases and exit
  --help                  Show this help
`;

const opts = {
	model: process.env.PI_EVAL_MODEL ?? "",
	provider: process.env.PI_EVAL_PROVIDER ?? "",
	caseFilter: "",
	maxCases: cases.length,
	timeoutSeconds: Number(process.env.PI_EVAL_TIMEOUT ?? "120"),
	keepOutput: false,
	list: false,
};

for (let index = 0; index < rawArgs.length; index += 1) {
	const arg = rawArgs[index];
	if (arg === "--help" || arg === "-h") {
		console.log(usage);
		process.exit(0);
	}
	if (arg === "--list") {
		opts.list = true;
		continue;
	}
	if (arg === "--keep-output") {
		opts.keepOutput = true;
		continue;
	}
	if (arg === "--model") {
		opts.model = rawArgs[++index] ?? "";
		continue;
	}
	if (arg === "--provider") {
		opts.provider = rawArgs[++index] ?? "";
		continue;
	}
	if (arg === "--case") {
		opts.caseFilter = rawArgs[++index] ?? "";
		continue;
	}
	if (arg === "--max-cases") {
		opts.maxCases = Number(rawArgs[++index] ?? "0");
		continue;
	}
	if (arg === "--timeout") {
		opts.timeoutSeconds = Number(rawArgs[++index] ?? "0");
		continue;
	}
	console.error(`[eval] ERROR: unknown option: ${arg}`);
	console.error(usage);
	process.exit(2);
}

if (!Number.isFinite(opts.timeoutSeconds) || opts.timeoutSeconds <= 0) {
	console.error("[eval] ERROR: --timeout must be a positive number");
	process.exit(2);
}
if (!Number.isFinite(opts.maxCases) || opts.maxCases <= 0) {
	console.error("[eval] ERROR: --max-cases must be a positive number");
	process.exit(2);
}

const selectedCases = cases
	.filter((testCase) => !opts.caseFilter || testCase.id.includes(opts.caseFilter))
	.slice(0, opts.maxCases);

if (opts.list) {
	for (const testCase of cases) {
		const expected = testCase.expected.length ? testCase.expected.join("|") : "none";
		console.log(`${testCase.id}\texpected=${expected}\t${testCase.prompt}`);
	}
	process.exit(0);
}

if (selectedCases.length === 0) {
	console.error("[eval] ERROR: no cases matched the requested filter");
	process.exit(2);
}

mkdirSync(join(tmpDir, "outputs"), { recursive: true });
if (opts.keepOutput) writeFileSync(join(tmpDir, "KEEP_OUTPUT"), "1\n");

const toolNames = [
	"gemini_status",
	"gemini_ask",
	"gemini_search",
	"gemini_research",
	"gemini_analyze",
	"gemini_results",
];
const systemPrompt = [
	"You are a concise assistant being evaluated for natural tool selection.",
	"Use an available tool when it is the best way to satisfy the user's request.",
	"Do not call a tool merely because tools exist; answer directly when no tool is needed.",
	"If a tool result starts with EVAL_TOOL_CALLED, treat it as complete and do not call another tool.",
	"After any tool result, give a one-sentence confirmation.",
].join(" ");

function parseJsonLines(stdout) {
	const events = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim().startsWith("{")) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// Ignore non-event noise from providers or startup warnings.
		}
	}
	return events;
}

function collectToolCalls(events) {
	const calls = [];
	const seen = new Set();
	for (const event of events) {
		if (event.type === "tool_execution_start" && event.toolName) {
			const key = `${event.toolCallId ?? calls.length}:${event.toolName}`;
			if (!seen.has(key)) {
				seen.add(key);
				calls.push({ name: event.toolName, args: event.args ?? {} });
			}
		}
	}
	return calls;
}

function matchesExpected(expected, calls) {
	if (expected.length === 0) return calls.length === 0;
	return calls.length > 0 && calls.every((call) => expected.includes(call.name));
}

function formatExpected(expected) {
	return expected.length ? expected.join("|") : "none";
}

let passed = 0;
let failed = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCost = 0;

console.log(`[eval] running ${selectedCases.length} natural tool-use case(s)`);
console.log(`[eval] mock extension: ${mockExtension}`);
if (opts.provider) console.log(`[eval] provider: ${opts.provider}`);
if (opts.model) console.log(`[eval] model: ${opts.model}`);

for (const testCase of selectedCases) {
	const outputPath = join(tmpDir, "outputs", `${testCase.id}.jsonl`);
	const piArgs = [
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-builtin-tools",
		"-e",
		mockExtension,
		"--tools",
		toolNames.join(","),
		"--system-prompt",
		systemPrompt,
		"--mode",
		"json",
		"--no-session",
	];
	if (opts.provider) piArgs.push("--provider", opts.provider);
	if (opts.model) piArgs.push("--model", opts.model);
	piArgs.push("-p", testCase.prompt);

	const run = spawnSync("pi", piArgs, {
		encoding: "utf8",
		timeout: opts.timeoutSeconds * 1000,
		maxBuffer: 20 * 1024 * 1024,
	});
	const combinedOutput = `${run.stdout ?? ""}${run.stderr ? `\n[stderr]\n${run.stderr}` : ""}`;
	writeFileSync(outputPath, combinedOutput);

	const events = parseJsonLines(run.stdout ?? "");
	const calls = collectToolCalls(events);
	for (const event of events) {
		const usage = event.message?.usage;
		if (event.type !== "message_end" || !usage) continue;
		totalInputTokens += Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
		totalOutputTokens += Number(usage.output ?? 0);
		totalCost += Number(usage.cost?.total ?? 0);
	}

	const ok = run.status === 0 && !run.error && matchesExpected(testCase.expected, calls);
	const actual = calls.length ? calls.map((call) => call.name).join(",") : "none";
	if (ok) {
		passed += 1;
		console.log(`PASS ${testCase.id} expected=${formatExpected(testCase.expected)} actual=${actual}`);
	} else {
		failed += 1;
		console.log(`FAIL ${testCase.id} expected=${formatExpected(testCase.expected)} actual=${actual} output=${outputPath}`);
		if (run.error) console.log(`  error=${run.error.message}`);
		if (run.status !== 0) console.log(`  exit=${run.status}`);
	}
}

const total = passed + failed;
const passRate = total ? passed / total : 0;
console.log(`NATURAL_TOOL_USE_PASSED=${passed}`);
console.log(`NATURAL_TOOL_USE_FAILED=${failed}`);
console.log(`NATURAL_TOOL_USE_PASS_RATE=${passRate.toFixed(4)}`);
console.log(`NATURAL_TOOL_USE_INPUT_TOKENS=${totalInputTokens}`);
console.log(`NATURAL_TOOL_USE_OUTPUT_TOKENS=${totalOutputTokens}`);
console.log(`NATURAL_TOOL_USE_COST=${totalCost.toFixed(6)}`);
console.log(`METRIC NATURAL_TOOL_USE_PASS_RATE=${passRate.toFixed(4)}`);

if (opts.keepOutput) console.log(`NATURAL_TOOL_USE_OUTPUT_DIR=${tmpDir}`);
process.exit(failed === 0 ? 0 : 1);
NODE
