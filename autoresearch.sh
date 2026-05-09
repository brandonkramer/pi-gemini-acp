#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Final benchmark with recommended configuration
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
    echo "METRIC p50=999999"
    echo "METRIC mean=999999"
    echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
    exit 0
}

MAX_RESULTS="${MAX_RESULTS:-4}"
EARLY_STOP="${EARLY_STOP:-0}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

# Simple warm benchmark
node scripts/bench.mjs \
    --mode warm \
    --runs 5 \
    --max-results "$MAX_RESULTS" \
    --json 2>/dev/null | node --input-type=module -e '
import { readFileSync } from "fs";
const json = JSON.parse(readFileSync(0, "utf8"));
const section = json.sections.find(s => s.mode === "warm");
if (!section?.summary?.totalMs) {
    console.log("METRIC p50=999999");
    console.log("METRIC mean=999999");
    process.exit(0);
}
const s = section.summary.totalMs;
console.log("METRIC p50=" + Math.round(s.p50 || 999999));
console.log("METRIC mean=" + Math.round(s.mean || 999999));
'
