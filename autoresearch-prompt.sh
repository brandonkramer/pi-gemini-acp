#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC p50=999999"
	echo "METRIC mean=999999"
	exit 0
}

MODE="${MODE:-warm}"
RUNS="${RUNS:-5}"
CHAT_PROMPT="${CHAT_PROMPT:-hi}"
HISTORY_TURNS="${HISTORY_TURNS:-0}"
HISTORY_ARG=""
if [ "$HISTORY_TURNS" -gt 0 ]; then
	HISTORY_ARG="--history-turns $HISTORY_TURNS"
fi

node scripts/bench.mjs \
	--bench chat \
	--mode "$MODE" \
	--runs "$RUNS" \
	--chat-prompt "$CHAT_PROMPT" \
	$HISTORY_ARG \
	--json 2>/dev/null | node --input-type=module -e '
import { readFileSync } from "fs";
const json = JSON.parse(readFileSync(0, "utf8"));
const section = json.sections.find(s => s.mode === "warm" || s.mode === "fresh");
if (!section?.summary?.promptMs || !section.runs?.length) {
    console.log("METRIC p50=999999");
    console.log("METRIC mean=999999");
    process.exit(0);
}
const s = section.summary.promptMs;
console.log("METRIC p50=" + Math.round(s.p50 || 999999));
console.log("METRIC mean=" + Math.round(s.mean || 999999));
'
