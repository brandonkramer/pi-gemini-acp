#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC firstRunMs=999999"
	echo "METRIC warmRunMs=999999"
	echo "METRIC speedup=0"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Test warm sequential pattern: measure first run vs subsequent runs
MAX_RESULTS="${MAX_RESULTS:-4}"
EARLY_STOP="${EARLY_STOP:-0}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

# Run benchmark with 5 runs in warm mode (same process)
bench_json=$(node scripts/bench.mjs \
	--mode warm \
	--runs 5 \
	--max-results "$MAX_RESULTS" \
	--json 2>/dev/null) || {
	echo "METRIC firstRunMs=999999"
	echo "METRIC warmRunMs=999999"
	echo "METRIC speedup=0"
	exit 0
}

# Parse: extract first run (includes init) vs median of subsequent runs
echo "$bench_json" | node --input-type=module -e '
import { readFileSync } from "node:fs";
const json = JSON.parse(readFileSync(0, "utf8"));
const section = json.sections.find(s => s.mode === "warm");
if (!section || !section.runs || section.runs.length < 2) {
	process.stdout.write("METRIC firstRunMs=999999\n");
	process.stdout.write("METRIC warmRunMs=999999\n");
	process.stdout.write("METRIC speedup=0\n");
	process.exit(0);
}

// First run includes init + session overhead
const firstRun = section.runs[0].totalMs;

// Subsequent runs are truly warm (same process, new session)
const subsequentRuns = section.runs.slice(1).map(r => r.totalMs);
subsequentRuns.sort((a, b) => a - b);
const warmMedian = subsequentRuns[Math.floor(subsequentRuns.length / 2)];

const speedup = firstRun / warmMedian;

process.stdout.write("METRIC firstRunMs=" + Math.round(firstRun) + "\n");
process.stdout.write("METRIC warmRunMs=" + Math.round(warmMedian) + "\n");
process.stdout.write("METRIC speedup=" + speedup.toFixed(2) + "\n");

// Also report init/session breakdown from first run
process.stdout.write("METRIC initMs=" + Math.round(section.runs[0].initializeMs || 0) + "\n");
process.stdout.write("METRIC sessionMs=" + Math.round(section.runs[0].sessionMs || 0) + "\n");
'
