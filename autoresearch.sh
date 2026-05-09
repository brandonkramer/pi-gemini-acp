#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC firstMs=999999"
	echo "METRIC fifthMs=999999"
	echo "METRIC stability=0"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Test rapid-fire: 10 searches back-to-back to verify no TTL timeout
MAX_RESULTS="${MAX_RESULTS:-4}"
EARLY_STOP="${EARLY_STOP:-0}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

result_file=$(mktemp)
trap "rm -f $result_file" EXIT

node scripts/bench.mjs \
	--mode warm \
	--runs 10 \
	--max-results "$MAX_RESULTS" \
	--json > "$result_file" 2>/dev/null || {
	echo "METRIC firstMs=999999"
	echo "METRIC fifthMs=999999"
	echo "METRIC stability=0"
	exit 0
}

# Analyze: first vs runs 5-10 (established warm)
node --input-type=module -e '
import { readFileSync } from "fs";
const json = JSON.parse(readFileSync(process.argv[1], "utf8"));
const section = json.sections.find(s => s.mode === "warm");

if (!section?.runs || section.runs.length < 8) {
	process.stdout.write("METRIC firstMs=999999\n");
	process.stdout.write("METRIC fifthMs=999999\n");
	process.stdout.write("METRIC stability=0\n");
	process.exit(0);
}

const first = section.runs[0].totalMs;
const established = section.runs.slice(4).map(r => r.totalMs);
established.sort((a, b) => a - b);
const fifth = established[Math.floor(established.length / 2)];

const stability = first / fifth;

process.stdout.write("METRIC firstMs=" + Math.round(first) + "\n");
process.stdout.write("METRIC fifthMs=" + Math.round(fifth) + "\n");
process.stdout.write("METRIC stability=" + stability.toFixed(2) + "\n");

// Also check for degradation trend
const times = section.runs.map(r => r.totalMs);
const trend = times.slice(-3).reduce((s, v) => s + v, 0) / 3 - times.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
process.stdout.write("METRIC trendMs=" + Math.round(trend) + "\n");
' "$result_file"
