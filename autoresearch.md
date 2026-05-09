# Autoresearch: Improve gemini_search Performance

## Objective
Optimize `gemini_search` latency through systematic experiments. The search involves network calls to Gemini ACP, so we focus on:
1. **Prompt efficiency** - already optimized with "Be concise" prefix
2. **maxResults tuning** - balance between result count and latency
3. **Early-stop optimization** - JSON streaming, abort after complete array
4. **Session warm/caching** - reduce cold-start overhead
5. **Idle TTL tuning** - balance memory vs process restart cost

## Metrics
- **Primary**: `totalMs_p50` (ms, lower is better) — median total search latency
- **Secondary**: `promptMs_p50`, `results`, `wallClockMs`, `initMs`, `sessionMs`

## How to Run
`./autoresearch.sh` — outputs `METRIC name=value` lines.

By default tests warm search with maxResults=5, running 3 times and reporting median.

## Files in Scope
- `src/acp/search-prompt.ts` — search prompt builder (already optimized)
- `src/acp/search-early-stop.ts` — JSON streaming/abort logic
- `src/acp/client-cache.ts` — warm session cache, idle TTL
- `src/acp/session.ts` — ACP process session management
- `scripts/bench.mjs` — existing benchmark harness

## Off Limits
- Do NOT change core search orchestration (run.ts)
- Do NOT change tool schemas or public APIs
- Do NOT add dependencies
- Do NOT break existing tests

## Constraints
- Tests must pass (`npm test`)
- TypeScript must compile (`npm run typecheck`)
- Changes must work in warm mode (most common)
- Network variance is high; need statistical confidence (≥2× noise floor)

## What's Been Tried

### ✅ Completed Optimizations (in baseline):
1. **"Be concise" prompt prefix** — reduces token generation, ~35-65% improvement
2. **maxResults tuning** — fewer results = faster; 3-4 is sweet spot vs default 5

### ✅ New Findings (This Session):

#### Experiment Results (5 runs, 2026-05-09):

| Configuration | Latency (p50) | Results | vs Baseline | Decision |
|-------------|---------------|---------|-------------|----------|
| **Baseline** (maxResults=5, early-stop) | 33,156ms | 5 | — | — |
| Disable early-stop (maxResults=5) | 20,192ms | 4 | **-39%** | ✅ **Keep** |
| **maxResults=4, early-stop disabled** | **11,560ms** | 4 | **-65%** | ✅ **Recommended** |
| maxResults=3, early-stop disabled | 7,015ms | 3 | -79% | Trade-off |
| maxResults=4, early-stop enabled | 26,108ms | 4 | -21% | ❌ Discard (w/ early-stop) |

**Key Finding: Early-stop adds 2-3× overhead.**

The intended optimization (aborting after JSON complete) is **slower** than natural stream completion. Possible reasons:
- Abort signal handling adds latency
- `returnTextOnAbort: true` fallback path is slower than native EOS
- The stream parsing overhead isn't offset by time saved

**Recommended Configuration:**
- `maxResults=4` (vs default 5) — good balance of results vs latency
- Set `PI_GEMINI_ACP_SEARCH_EARLY_STOP=0` to disable early-stop
- Expected improvement: **65% faster** with only 1 fewer result

### 🔄 Remaining Hypotheses:
1. **Idle TTL extension** — Longer than 15min reduces cold starts (trade-off: memory usage)
2. **Session prewarm** — Ensure session warm before search to reduce init
3. **Parallel search** — For independent queries (batch workloads)
4. **Prompt token reduction** — Further shorten JSON format spec

## Learned So Far
- Network variance dominates (2s-20s range), need many runs for signal
- "Be concise" behavioral cue works; prescriptive constraints don't
- **Early-stop hurts performance** — abort mechanism adds 2-3× latency overhead
- Warm session reuse already implemented; focus on keeping it warm
- maxResults=4 is the sweet spot (4 results, ~11s vs 33s baseline)
- Diminishing returns: 3→4 adds ~4.5s, 4→5 adds ~8.6s

## Implementation Notes

To deploy the optimization:
1. Change default `maxResults` from 5 to 4 in tool schema or runtime
2. Consider disabling early-stop by default (`PI_GEMINI_ACP_SEARCH_EARLY_STOP=0`)
3. Document the trade-off: 65% faster, 1 fewer result
