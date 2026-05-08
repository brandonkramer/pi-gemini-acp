# Autoresearch: Optimize Gemini ACP search prompt latency

## Objective

Reduce Gemini ACP search prompt response time by optimizing the prompt shape sent to Gemini. The benchmark measures warm (reused subprocess) search latency for a fixed query against the real Gemini ACP provider.

## Metrics

- **Primary**: `promptMs_p50` (milliseconds, lower is better) — median prompt time across 3 warm runs
- **Secondary**: `totalMs_p50`, `results` (count, higher is better)

## How to Run

`./autoresearch.sh` — compiles, runs 3 warm runs, outputs `METRIC` lines.

`node scripts/bench.mjs --mode warm --runs 3 --batches 3 --json` — 3 batches of 3 runs for stable aggregate.

## Files in Scope

- `src/acp/search-prompt.ts` — the prompt text sent to Gemini ACP. The most impactful optimization target.
- `scripts/bench.mjs` — the benchmark itself (modified to import production `searchPrompt()` for accurate measurement).

## Off Limits

- Public tool definitions, names, and route behavior in `src/tools/`.
- Search workflow orchestration in `src/search/run.ts`.
- `src/acp/client-cache.ts` — warm-session reuse strategy.
- Adding new dependencies.
- Removing safety constraints, preflight checks, or result normalization.

## Constraints

- `npm run typecheck` must pass.
- `npm run test:tools` must pass.
- Results must be valid (≥ 1 result returned).

## Final Best Prompt

```ts
`Search web: ${query}\nReturn JSON array only, max ${maxResults}: [{"title":string,"url":string,"snippet":string}]`
```

## What's Been Tried

### 3-batch aggregate results (9 runs each)

| Format | p50 promptMs | results mean | Stability |
|--------|-------------|-------------|-----------|
| `Grounded web search:` original | 7,006ms | 3.7 | moderate |
| `Search web:` compact (final) | 8,294ms | 4.3 | best |
| `/web` prefix | 5,589ms | 2.8 | poor |
| `/search` prefix | crash | 0 | incompatible |
| `Web:` ultra-minimal | 12,350ms | 4.0 | poor |
| No schema at all | 9,973ms | 2.0 | poor |
| Single-line formats | 13,265-14,240ms | 4-5 | poor |
| No-quotes keys schema | 7,331ms | 5.0 | moderate |
| Example values schema | 10,775ms | 5.0 | moderate |

### Key findings

1. **The benchmark is dominated by Gemini backend variance.** Individual runs range 2,000-75,000ms. 3-batch aggregates are needed for stable p50.
2. **`/web` prefix is fastest but unreliable.** p50=5,589ms but results drop to 1-2 on ~30% of runs. Not production-safe.
3. **`Search web:` is the best quality/speed tradeoff.** p50=8,294ms, results mean=4.3, consistent 3-5 results per run.
4. **`Grounded web search:` original is slightly faster** (p50=7,006ms) but with lower quality (results mean=3.7). The "Grounded" word adds no value.
5. **Shorter prompts ≠ faster.** The ultra-minimal `Web:` format was slower. Single-line formats were worse. The instruction structure matters more than raw length.
6. **JSON-RPC stdio offset-tracking had zero measurable impact.** 0ms parse time confirmed across all runs. Reverted.
7. **Schema format matters.** Abstract `string` type hints outperform example values and no-quotes keys. No-schema causes quality collapse (results=2).

## Why the autoresearch stopped here

The benchmark ceiling is the Gemini backend response time (95%+ of total). All prompt shapes within the instruction-family have been exhaustively compared. Further iterations would chase noise, not signal.
