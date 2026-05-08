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
import { validateToolCall } from "@mariozechner/pi-ai";

const distDir = process.argv[2];
const { geminiAcpTools } = await import(`${distDir}/tools/register.js`);

const expectedToolNames = [
	"gemini_status",
	"gemini_prompt",
	"gemini_extract",
	"gemini_summarize",
	"gemini_search",
	"gemini_research",
	"gemini_file_analyze",
	"gemini_code_review",
	"gemini_translate",
	"gemini_image_describe",
	"gemini_recall",
	"gemini_get_result",
];

const sampleCalls = {
	gemini_status: {},
	gemini_prompt: { prompt: "Explain Gemini ACP configuration." },
	gemini_extract: {
		content: "Project: Pi. Status: green.",
		prompt: "Extract project and status.",
		schema: {
			type: "object",
			properties: { project: { type: "string" }, status: { type: "string" } },
			required: ["project", "status"],
		},
	},
	gemini_summarize: { content: "Alpha beta gamma.", bulletCount: 2 },
	gemini_search: {
		query: "Gemini ACP search grounding",
		localDocuments: [{ url: "https://example.com", text: "Gemini ACP" }],
	},
	gemini_research: { query: "Gemini ACP source citation behavior", maxResults: 3 },
	gemini_file_analyze: { paths: ["README.md"], instructions: "Summarize this file." },
	gemini_code_review: { code: "const x = 1;", language: "typescript" },
	gemini_translate: { text: "hello", targetLanguage: "Spanish" },
	gemini_image_describe: { imagePath: "diagram.png", mode: "caption" },
	gemini_recall: { query: "prior Gemini search about ACP" },
	gemini_get_result: { responseId: "response-123" },
};

const routingCases = [
	["check gemini acp status and auth", "gemini_status"],
	["status for the local gemini command", "gemini_status"],
	["ask gemini a plain prompt", "gemini_prompt"],
	["send an arbitrary prompt to authenticated gemini acp", "gemini_prompt"],
	["extract structured json from this text", "gemini_extract"],
	["validate returned json against a schema", "gemini_extract"],
	["summarize this supplied content", "gemini_summarize"],
	["summarize a safe public url", "gemini_summarize"],
	["search the web with gemini grounding", "gemini_search"],
	["search supplied local documents", "gemini_search"],
	["research a topic with sources and citations", "gemini_research"],
	["hydrate source text for a research pass", "gemini_research"],
	["analyze this local file with resource links", "gemini_file_analyze"],
	["read a document file after path validation", "gemini_file_analyze"],
	["review this diff for correctness", "gemini_code_review"],
	["analyze code without editing files", "gemini_code_review"],
	["translate text into Spanish", "gemini_translate"],
	["localize a batch with glossary terms", "gemini_translate"],
	["describe this local image path", "gemini_image_describe"],
	["ocr an image file through gemini", "gemini_image_describe"],
	["recall prior cached gemini results", "gemini_recall"],
	["search local fts recall hits", "gemini_recall"],
	["retrieve a stored full output by response id", "gemini_get_result"],
	["get result responseId from storage", "gemini_get_result"],
];

const stopWords = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
	"is", "it", "of", "on", "or", "the", "this", "to", "with", "without",
]);

function schemaTokenScore(value) {
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

const perTool = geminiAcpTools.map((tool) => ({
	name: tool.name,
	tokens: schemaTokenScore(surfaceFor(tool)),
}));
const total = perTool.reduce((sum, tool) => sum + tool.tokens, 0);

for (const tool of perTool) console.log(`TOOL_TOKEN ${tool.name}=${tool.tokens}`);
console.log(`ROUTING_PASS_RATE=${routingPassRate.toFixed(4)}`);
console.log(`TOOL_COUNT=${geminiAcpTools.length}`);
console.log(`TOOL_TOKEN_SCORE=${total}`);
console.log(`METRIC TOOL_TOKEN_SCORE=${total}`);
NODE
