# Changelog

All notable changes to `pi-gemini-acp` are documented here.

This changelog is maintained from git history and follows a Keep-a-Changelog-style format.

## [Unreleased]

- Documented the expected fixed Gemini ACP process shape: top-level Pi may keep prompt/search warm subprocesses plus live chat/tool subprocesses, and each Gemini CLI wrapper can appear as a `node` parent plus `node-22` child. Recursive Gemini-spawned `pi` loads are guarded separately via `GEMINI_CLI=1`.

## [0.20.0] - 2026-05-16

### Added

- **Multi-account failover:** configure multiple authenticated Gemini CLI accounts under `providers.accounts`; when one account hits quota exhaustion the extension transparently retries on the next healthy account (`28ff952`–`05326b4`).
- `AccountPool` class with per-account cooldown tracking, same-account retry on configured HTTP codes (default: 429), and immediate failover on other errors (`1f485a6`).
- Quota reset duration parsed from Gemini error messages (e.g. "reset after 2h21m46s") for precise cooldown; falls back to `coolDownSeconds` when not parseable (`1f485a6`).
- `getAccountPoolStatus` exposed in `gemini_status` output — shows active account count and cooled-down accounts with remaining minutes (`12a741f`).
- README: multi-account failover configuration example and local install instructions (`c0ba8fd`).

### Fixed

- **Recursive ACP spawn workaround:** when Gemini autonomously invokes `pi` subcommands via its `run_shell_command` tool (e.g. `pi mcp list`), the extension is re-loaded inside the Gemini subprocess and previously spawned a fresh pair of prewarm subprocesses, which could recurse without bound. The extension now detects the `GEMINI_CLI=1` env var that Gemini CLI sets on its shell-tool children and skips activation paths that can spawn ACP subprocesses in that nested context: model adapter registration, model-provider registration/auth probing, prompt/search prewarm, and cache-retention sweep. Tools and commands still register normally.
- Restore `retries` semantics to match the design spec and README: `retries: N` now means N extra attempts after the initial try (N+1 total) rather than N total attempts. Default `retries: 3` therefore allows 4 attempts on the same account before failover.
- `AccountPoolExhaustedError` now exposes the underlying last error as `cause`, so prompt/search error paths preserve the upstream diagnostic instead of collapsing it to the generic "all accounts exhausted" message.

## [0.12.0] - 2026-05-14

### Added

- New `gemini-3.1-flash-preview` model; it now owns the `flash` alias and is the default API-key fallback model (`855199c`).
- Paged/shaped stored result views with overview, source, and raw renderings (`src/results/shape*`, `pagination.ts`, `source-notes.ts`) (`855199c`).
- README "Chat models" section listing the eight registered Pi chat model ids with picker labels and CLI aliases (`4dae70b`).

### Changed

- Demote `gemini-3-flash-preview` to compatibility status; the `flash` alias now resolves to `gemini-3.1-flash-preview` (`855199c`).
- Make the extension factory async with awaited provider registration (`855199c`).

### Removed

- Drop unused dev scripts (`scripts/check-dup.sh`, `check-residue.sh`, `similarity.sh`, `reliability-smoke.mjs`, `dup.toml`) and corresponding lefthook pre-commit jobs / package scripts (`855199c`).

## [0.11.0] - 2026-05-13

### Added

- Chat-mode benchmark with TTFT and tokens/sec measurements (`e1c41a6`).
- `maxHistoryMessages` setting to cap conversation history per turn for lower latency.
- Chat prompt session prewarm: hidden warmup at Pi registration reduces first-prompt TTFT by ~64% (`66cf973`).

### Changed

- Reuse ACP sessions across chat turns in `CachedGeminiAcpClient`; TTFT improves ~3× on reused sessions and compounds with conversation length (`bfec85f`).
- Bump API-key fallback default model to `gemini-3-flash-preview` (`ffe6dfa`).
- Refactor URL helpers into dedicated `src/url` module (`673f21b`, `26390ad`, `6f867ce`, `6cbdc02`).

### Fixed

- Drop stale `vec0` trigger on cache open; surface cause in write warning (`0d3637d`).
- Classify `UNSUPPORTED_TRANSPORT` API-key errors with own non-retryable code (`3ccc7ab`).
- Gate IPv6 private checks on bracketed hostnames to avoid DNS false positives (`05dd418`).
- Apply 4 MiB default cap to production fetch callers; cancel stream on truncation (`c0fe5d2`).
- Strip `models/` prefix from API-key fallback model IDs (`4d830c5`).
- Block API-key fallback for ACP-only file analysis operations (`e58679f`).
- Surface provider search/preflight errors in `gemini_research` instead of masking as empty results (`1c81f76`).
- Correct API-key fallback request shape and model name for prompt/search paths (`930ab13`).
- Stream-read response body with byte limit instead of buffering entire text (`e47eb97`).

### Security

- Block link-local, CGNAT, and IPv4-mapped IPv6 ranges; fix redirect hop off-by-one (`88dff7d`).
- Validate redirect targets against SSRF rules (`6049837`).

## [0.10.0] - 2026-05-09

### Added

- Added Gemini API key fallback: when `GEMINI_API_KEY` is set, `gemini_search`, `gemini_research`, and `gemini_ask` automatically fall back to the Gemini REST API if local ACP is unavailable. `gemini_status` reports whether the fallback is configured.

### Changed

- Changed Gemini ACP search early-stop to opt-in via `PI_GEMINI_ACP_SEARCH_EARLY_STOP=1`, keeping full-turn completion as the default for lower observed latency.
- Changed the default `gemini_search`/`gemini_research` source count from 5 to 4 results for the best observed latency/quality tradeoff.
- Serialized live Gemini ACP searches by default; set `PI_GEMINI_ACP_SEARCH_PARALLEL=1` to opt into concurrent live searches.
- Expanded search progress messages to distinguish warm process reuse, search-session creation/reuse, Gemini backend wait, and first-token generation.
- Shared Gemini backend wait and first-token progress across `gemini_ask` prompt workflows and `gemini_analyze` file/image analysis.
- Added process-local search prewarm status to `gemini_status` output.

## [0.9.1] - 2026-05-09

### Changed

- Prepended `Be concise.` to the Gemini ACP search prompt to reduce response latency without changing the JSON output contract (`b287637`, `src/acp/search-prompt.ts`).

## [0.9.0] - 2026-05-09

### Added

- Added persistent Gemini tool response caching backed by SQLite, with cache markers, retention, atomic result writes, and `/gemini-config cache` controls (`81db6da`).
- Added semantic-recall infrastructure: `sqlite-vec`, embedding queue/schema, recall text generation, recall enable/disable status, and an honest unavailable production embedder seam (`e6f96a2`).
- Added the public `gemini_recall` tool plus opt-in `useRecall` / `bypassRecall` support for `gemini_search` and `gemini_research` (`3d19496`).
- Added lexical recall and local search fast paths (`6e76308`).
- Added a tool token-surface evaluator under `eval/` (`9252890`).

### Changed

- Collapsed twelve individual public Gemini tools into six aggregate `gemini_*` tools (`24c7cf8`); follow-up commits compacted descriptions and schemas while preserving cache, recall, freshness, and analyze safety guidance.
- Optimized `gemini_search` warm-process reuse and parallel sessions, and improved search bench/prompt reliability (`82c972f`, `0d54bc2`).
- Optimized the `gemini_ask` token surface, including compact enum schemas for routing fields and consolidated description guidance (`a416dad`, `517f603`, `7df6e3c`, `4161170`, `a810b8f`).
- Shared provider-result handling across prompt/search/tool/config paths (`c6d7c9d`, `d332f9d`).
- Shared JSON-RPC-over-stdio transport between ACP sessions and benchmark tooling (`adc0d98`).

### Fixed

- Indexed local search results into recall (`2a7921d`).
- Disabled the vector recall fallback when no embedder is available (`9369914`).

### Notes

- The aggregate-tool collapse is a breaking change to the public tool surface; consumers calling the previous twelve tool names must migrate to the six `gemini_*` aggregates.
- `gemini_recall` is capability-gated: it returns an unavailable provider/capability error until a real embedding provider is configured and preflighted.

## [0.8.0] - 2026-05-04

### Added

- Added real `gemini_image_describe` support for explicit local image paths through validated ACP image `resource_link` parts (`21f9af6`).
- Added documentation for image-description requirements and Gemini ACP configuration (`6c693c5`, `a68ab4d`, `e5755b9`).

### Notes

- Base64 image provider transport remains unsupported; local image paths require filesystem-read permission and confirmed image/resource-link capabilities.

## [0.7.1] - 2026-05-04

### Fixed

- Made ACP tool cancellation behavior consistent across Gemini-backed tools (`787176a`).

### Performance

- Cached Gemini ACP search preflight checks and extended warm-client idle TTL (`cd42b7e`).
- Reused neutral-cwd cached Gemini search sessions (`4ecc1da`).
- Prewarmed Gemini ACP search on activation (`3a3e836`).
- Cancelled Gemini ACP search after streamed JSON is detected (`85d9dec`).
- Shortened the Gemini ACP search prompt (`f9101a1`).

### Tests

- Added Windows command-shim quoting regression coverage (`927926e`).
- Excluded local Pi worktrees from Vitest runs (`1479aaf`).

## [0.7.0] - 2026-05-04

### Added

- Added validated `gemini_file_analyze` support using ACP file/document `resource_link` transport (`dde3532`).

### Fixed

- Resolved Windows Gemini command shim handling (`7c51047`).
- Improved `gemini_research` assistant output (`79dd4fe`).
- Exposed Gemini request arguments in progress output (`2c01943`).
- Showed extracted JSON directly in `gemini_extract` output (`0d34434`).

## [0.6.0] - 2026-05-03

### Added

- Added consistent Gemini tool rendering UX across Gemini tools (`a51c503`).

### Changed

- Extracted shared Gemini rendering primitives (`3bed45b`).
- Improved Gemini search tool UX (`7521ede`).

## [0.5.2] - 2026-05-03

### Changed

- Avoided unnecessary Gemini workspace trust checks (`e030c36`).

## [0.5.1] - 2026-05-03

### Changed

- Confirmed Gemini authentication during preflight (`34b4b2d`).

### Docs

- Refined README requirements, configuration guidance, and project summary (`c3ae66c`, `12dd07b`, `3d72c5e`).

### CI

- Skipped CI for markdown-only changes (`a855e80`).

## [0.5.0] - 2026-05-03

### Added

- Added warm Gemini prompt/search sessions and benchmark coverage (`a678e5b`, `f066b40`, `42ce4b7`, `7a8f497`).
- Added interactive pickers for `/gemini-config` and `/gemini-model` (`8a789e6`, `2d5cf53`, `d0581d7`).

### Changed

- Combined older Gemini config/status commands into `/gemini-config` (`8e9dc97`).
- Renamed `/gemini-config persist` to `/gemini-config command` (`d32c2d0`).
- Reworked permission toggles into `/gemini-config permissions` (`a536835`).
- Improved status evaluation by merging defaults before reporting status (`9bf63b4`).

### Docs

- Tightened configuration and command documentation (`520f2c6`, `32c00ec`, `5fb2e4a`).

## [0.4.0] - 2026-05-02

### Added

- Added capability-gated file and image tool surfaces (`1cf0f72`).
- Added Gemini status command support (`21895cc`).
- Added prompt-based Gemini tools for prompt, extraction, summarization, code review, and translation workflows (`cd1bbe1`, `5692a90`).

### Changed

- Renamed tool modules from `gemini-acp-*` to stable `gemini-*` names (`d32a02e`).
- Renamed command surface toward the stable `/gemini-*` command names (`55ab91d`, `2aaad57`).
- Added Gemini 3 preview model choices to curated model aliases (`b0528bb`).

## [0.3.0] - 2026-05-02

### Added

- Added default `gemini --acp` provider configuration and model selection aliases (`933b76d`).

## [0.2.1] - 2026-05-02

### Fixed

- Fixed command registration compatibility with Pi's two-argument `registerCommand` host API (`4d1490c`).

## [0.2.0] - 2026-05-02

### Fixed

- Added repository metadata required for Sigstore provenance validation (`bd7927d`).

## [0.1.0] - 2026-05-02

### Added

- Initial `pi-gemini-acp` package seed (`182a9d1`).
- Added CI/publish workflows, lint/audit tooling, and packaged Gemini skill setup (`5bb606b`).
- Added early Gemini model/login/permission commands (`e181cf3`).

[Unreleased]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brandonkramer/pi-gemini-acp/releases/tag/v0.1.0
