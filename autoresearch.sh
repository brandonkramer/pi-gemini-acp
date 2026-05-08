#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC promptMs_p50=999999"
	echo "METRIC totalMs_p50=999999"
	echo "METRIC results=0"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Run warm benchmark, capture JSON result
bench_json=$(node scripts/bench.mjs --mode warm --runs 3 --timeout-ms 120000 --json 2>/dev/null) || {
	echo "METRIC promptMs_p50=999999"
	echo "METRIC totalMs_p50=999999"
	echo "METRIC results=0"
	exit 0
}

# Parse metrics from JSON via a temp file (avoids stdin redirection conflicts)
echo "$bench_json" >/tmp/autoresearch-bench.json
node --input-type=module -e '
import { readFileSync } from "node:fs";
const json = JSON.parse(readFileSync("/tmp/autoresearch-bench.json", "utf8"));
const warmSections = json.sections.filter(s => s.mode === "warm");
for (const section of warmSections) {
  const promptMs = section.runs.map(r => r.promptMs).sort((a,b) => a-b);
  const totalMs = section.runs.map(r => r.totalMs).sort((a,b) => a-b);
  const results = section.runs.map(r => r.results);
  const p50Idx = Math.floor(promptMs.length / 2);
  const avgResults = results.reduce((s,v) => s+v, 0) / results.length;
  process.stdout.write("METRIC promptMs_p50=" + promptMs[p50Idx] + "\n");
  process.stdout.write("METRIC totalMs_p50=" + totalMs[p50Idx] + "\n");
  process.stdout.write("METRIC results=" + Math.round(avgResults) + "\n");
  process.stdout.write("METRIC variant=" + section.promptVariant + "/max" + section.maxResults + "\n");
  process.stdout.write("METRIC promptMs_all=" + promptMs.join(",") + "\n");
  process.stdout.write("METRIC totalMs_all=" + totalMs.join(",") + "\n");
}
'
