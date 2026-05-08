#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-gemini-tool-tokens.XXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

DIST_DIR="$TMP_DIR/dist"

cd "$ROOT_DIR"
npx tsc -p tsconfig.json \
	--rootDir src \
	--outDir "$DIST_DIR" \
	--noEmit false \
	--declaration false \
	--sourceMap false >/dev/null
ln -s "$ROOT_DIR/node_modules" "$TMP_DIR/node_modules"

node --input-type=module - "$DIST_DIR" <<'NODE'
import { validateToolCall } from "@earendil-works/pi-ai";

const distDir = process.argv[2];
const { geminiAcpTools } = await import(`${distDir}/tools/register.js`);

const expectedToolNames = [
	"gemini_status",
	"gemini_ask",
	"gemini_search",
	"gemini_research",
	"gemini_analyze",
	"gemini_results",
];

const sampleCalls = {
	gemini_status: {},
	gemini_ask: { task: "prompt", prompt: "Explain Gemini ACP configuration." },
	gemini_search: {
		query: "Gemini ACP search grounding",
		localDocuments: [{ url: "https://example.com", text: "Gemini ACP" }],
	},
	gemini_research: { query: "Gemini ACP source citation behavior", maxResults: 3 },
	gemini_analyze: { kind: "file", paths: ["README.md"], instructions: "Summarize this file." },
	gemini_results: { action: "get", responseId: "response-123" },
};

const routingCases = [
	["check gemini acp status and auth", "gemini_status"],
	["status for the local gemini command", "gemini_status"],
	["ask gemini a plain prompt", "gemini_ask"],
	["run a text task with a prompt", "gemini_ask"],
	["extract structured json from this text", "gemini_ask"],
	["validate returned json against a schema", "gemini_ask"],
	["summarize this supplied content", "gemini_ask"],
	["summarize a safe public url", "gemini_ask"],
	["search the web with gemini grounding", "gemini_search"],
	["search localDocs content", "gemini_search"],
	["research a topic with sources and citations", "gemini_research"],
	["hydrate source text for a research pass", "gemini_research"],
	["analyze this local file with resource links", "gemini_analyze"],
	["read a document file after path validation", "gemini_analyze"],
	["review this diff for correctness", "gemini_ask"],
	["analyze code without editing files", "gemini_ask"],
	["translate text into Spanish", "gemini_ask"],
	["localize a batch with glossary terms", "gemini_ask"],
	["describe this local image path", "gemini_analyze"],
	["ocr an image file through gemini", "gemini_analyze"],
	["recall prior cached gemini results", "gemini_results"],
	["search local fts recall hits", "gemini_results"],
	["retrieve a stored full output by response id", "gemini_results"],
	["get result responseId from storage", "gemini_results"],
];

const stopWords = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
	"is", "it", "of", "on", "or", "the", "this", "to", "with", "without",
]);

function char4TokenScore(value) {
	return Math.ceil(String(value).length / 4);
}

function regexTokenScore(value) {
	const json = JSON.stringify(value);
	return (json.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []).length;
}

function words(value) {
	return String(value)
		.toLowerCase()
		.replace(/gemini_/g, "gemini ")
		.match(/[a-z0-9]+/g)?.filter((word) => !stopWords.has(word)) ?? [];
}

function surfaceFor(tool) {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
	};
}

function metricSpecFor(tool) {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	};
}

function routingSurfaceText(tool) {
	const surface = surfaceFor(tool);
	return JSON.stringify(surface)
		.replace(/responseid/gi, "response id")
		.replace(/filesystem/gi, "file system")
		.replace(/no-key/gi, "local")
		.replace(/fts/gi, "fts recall search")
		.replace(/ocr/gi, "ocr image text");
}

function route(query) {
	const queryWords = words(query);
	let best;
	for (const tool of geminiAcpTools) {
		const toolWords = words(routingSurfaceText(tool));
		const frequencies = new Map();
		for (const word of toolWords) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
		let score = 0;
		for (const word of queryWords) {
			const count = frequencies.get(word) ?? 0;
			if (count) score += 1 + Math.min(count, 4) * 0.25;
		}
		if (!best || score > best.score) best = { name: tool.name, score };
	}
	return best?.name;
}

function fail(message) {
	console.error(`ERROR ${message}`);
	process.exitCode = 1;
}

const toolNames = geminiAcpTools.map((tool) => tool.name);
if (JSON.stringify(toolNames) !== JSON.stringify(expectedToolNames)) {
	fail(`public tool names changed: ${JSON.stringify(toolNames)}`);
}

for (const tool of geminiAcpTools) {
	if (!tool.description || typeof tool.description !== "string") fail(`${tool.name} has no description`);
	if (!tool.parameters || tool.parameters.type !== "object") fail(`${tool.name} schema is not an object`);
	JSON.stringify(tool.parameters);
	validateToolCall(geminiAcpTools, { name: tool.name, arguments: sampleCalls[tool.name] });
}

let passedRoutes = 0;
for (const [query, expected] of routingCases) {
	const actual = route(query);
	if (actual === expected) {
		passedRoutes += 1;
	} else {
		console.error(`ROUTING_FAIL query=${JSON.stringify(query)} expected=${expected} actual=${actual}`);
	}
}
const routingPassRate = passedRoutes / routingCases.length;
if (routingPassRate < 0.95) fail(`routing pass rate ${(routingPassRate * 100).toFixed(1)}% < 95%`);

const perTool = geminiAcpTools.map((tool) => {
	const metricSpec = metricSpecFor(tool);
	return {
		name: tool.name,
		tokens: char4TokenScore(JSON.stringify(metricSpec)),
		regexTokens: regexTokenScore(surfaceFor(tool)),
	};
});
const serializedMetricSpecs = geminiAcpTools
	.map((tool) => JSON.stringify(metricSpecFor(tool)))
	.join("");
const total = char4TokenScore(serializedMetricSpecs);
const regexTotal = perTool.reduce((sum, tool) => sum + tool.regexTokens, 0);

for (const tool of perTool) console.log(`TOOL_TOKEN ${tool.name}=${tool.tokens}`);
for (const tool of perTool) console.log(`TOOL_TOKEN_REGEX ${tool.name}=${tool.regexTokens}`);
console.log(`ROUTING_PASS_RATE=${routingPassRate.toFixed(4)}`);
console.log(`TOOL_COUNT=${geminiAcpTools.length}`);
console.log(`TOOL_CHARS=${serializedMetricSpecs.length}`);
console.log(`TOOL_TOKEN_SCORE=${total}`);
console.log(`TOOL_TOKEN_SCORE_REGEX=${regexTotal}`);
console.log(`METRIC TOOL_TOKEN_SCORE=${total}`);
NODE
