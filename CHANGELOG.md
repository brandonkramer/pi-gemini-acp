# Changelog

All notable changes to `pi-gemini-acp` are documented here.

This changelog is maintained from git history and follows a Keep-a-Changelog-style format.

## [Unreleased]

### Added

- `webFetch` permission capability for Gemini's `web_fetch` tool (ACP kind `fetch`), which was previously always refused. Enabling it for the `gemini_*` tools requires `confirmRisk=true`.
- `gemini-auto` model (Gemini CLI's routing model, which picks Flash or Pro per request), selectable through `/gemini-model` and Pi's model selector. `auto` and `models/auto` are accepted as aliases.
- `gemini_*` tools are shown only while a Gemini model is active and are restored when switching back. `/gemini-config search enable|disable|status` controls `gemini_search`; `PI_GEMINI_ACP_SEARCH=0` overrides the saved setting.
- Opt-in metadata-only ACP tracing through `PI_GEMINI_ACP_TRACE_FILE`, including request durations, queue waits, permission decisions, and thought/tool update types.
- ACP traces record each Gemini tool call's kind, status and duration (`tool.end`) and a per-turn `prompt.end` summary (outcome, stop reason, time to the first answer text, tool-call, permission and thought counts, longest tool run), so a slow turn shows where the time went.
- Chat turns show the tools Gemini runs on its own like Pi's own tool calls: each finished call appears above the answer with its command, output (collapsed; Ctrl+O expands) and duration, and Pi's working line names the running call. Permission requests denied by the Gemini ACP permission policy appear the same way. Gemini's thoughts go to the thinking block, so a long turn no longer shows only "Thinking...", even with `hideThinkingBlock`.
- Configurable ACP deadlines: 60 seconds per initialization/session-creation request and 30 minutes per prompt. Timeouts invalidate the transport and do not replay potentially completed actions through account failover.
- `chat.maxHistoryChars` (default 200,000 characters) bounds the prompt sent to a fresh Gemini chat session, including the preamble or system prompt: older tool results are shortened first, then the oldest messages are dropped.
- Stall detection for chat and tool prompts: a prompt that sends no progress for 10 minutes while none of Gemini's own tools is running is cancelled with an explanatory error (`PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS`, `0` disables it). Like other timeouts, it is never replayed on another account.
- Per-tool limit for chat and tool prompts: if one of Gemini's tool calls runs for more than 10 minutes (for example a web search stuck in server-side retries), the turn is cancelled with an explanatory error (`PI_GEMINI_ACP_TOOL_TIMEOUT_MS`, `0` disables it).

### Changed

- Separate permission policies for chat and for the `gemini_*` tools. Chat sessions (Gemini selected as Pi's model) allow file reads, file writes, terminal and web fetch by default, like Pi itself; previously every edit and command Gemini asked for was refused until the policy was changed. A policy saved earlier keeps applying to chat. The tools stay restrictive by default and still require `confirmRisk=true` for writes, terminal and web fetch, since they usually process untrusted content. `/gemini-config permissions chat|tools …` edits either policy; `/gemini-config status` shows both.

### Fixed

- The chat provider runs Gemini CLI with the model selected in Pi (`model.id`). Previously the model saved with `/gemini-model` (`settings.model`) always won, so choosing another Gemini model in Pi's model selector had no effect on chat turns.
- Read Pi's system prompt from the normalized transcript that Pi 0.8x passes to providers. With Pi 0.87 the chat adapter dropped the system prompt and sent a stray `Tool (undefined):` line instead.
- Chat streams emit balanced `text_start`/`text_delta`/`text_end` events and call `onPayload`, as Pi's provider contract requires.
- A Gemini tool call that needs permission counts as running from its approval. Gemini CLI sends no start update for such calls, so the stall detector could cancel a turn while an approved command was still working, and the trace reported their duration as 0 ms.
- Chat usage uses the token counts Gemini CLI reports instead of a character-count estimate, and Gemini's stop reason is mapped (`max_tokens` → `length`; a refusal is reported as an error).
- Chat turns no longer replay Pi's whole history into the same Gemini session, which grew the context quadratically. A chat continues the Gemini session that holds its earlier messages and sends only the new ones, which also saves creating a session per turn. A turn that cannot be matched to such a session (branch switch, compaction, changed model or system prompt, failed or aborted turn) starts a fresh session with the full history. `maxHistoryMessages: 0` now keeps only the latest message.
- Restart the warm chat process after 25 fresh chat sessions (`PI_GEMINI_ACP_MAX_PROMPT_SESSIONS`), because ACP cannot close them and they would otherwise accumulate in Gemini CLI's memory.
- A long chat no longer fails with Gemini's "input token count exceeds the maximum number of tokens allowed". Gemini CLI keeps its own tool calls and their output in a continued session, so the session could outgrow the 1,048,576-token limit. Once a turn reports 600,000 input tokens or more (`PI_GEMINI_ACP_MAX_SESSION_INPUT_TOKENS`), the next turn starts a fresh session. A continued turn rejected for its size before producing output is retried once on a fresh session. The error is no longer retried on the same account, does not fail over, and does not put the account on cooldown. `prompt.end` trace records include the reported input tokens.
- Cancel queued and startup waits promptly, reject requests on dead transports, and retain JSON-RPC error codes.
- Stop advertising unimplemented filesystem-write and terminal handlers. Gemini CLI can use its local write service instead of failing every delegated edit with `Method not found`.
- Classify permission requests by ACP tool kind rather than command arguments or diff contents.
- `/gemini-config status` lists the ACP client services actually advertised to Gemini (file reads for file analysis only; no file writes or terminal) and explains that Gemini's own edits and commands are governed by permission requests, instead of showing them as "future capability flags".
- Chat turns warn when Gemini CLI runs in its `autoEdit` or `yolo` approval mode, in which it does not ask Pi for permission and the Gemini ACP permission policy is bypassed. The mode is recorded in the ACP trace.
- Prewarm the chat process for the Pi-selected Gemini model, once a session starts or the model changes, instead of for the configured model at activation. The first turn can now use it, and no chat process is started while a non-Gemini model is active.
- Honor `PI_GEMINI_ACP_NO_PREWARM` for chat prewarming as well as search.
- Advertise `fs.readTextFile` only for sessions that serve file reads (file analysis). Chat and search sessions no longer fail every project file read with "denied by the Pi allowlist".
- Close a Gemini process that is still initializing on shutdown instead of waiting for it, decide on `SIGKILL` escalation from the real exit state, and let Pi still terminate on `SIGTERM`/`SIGHUP` after cleanup.
- The chat preamble tells Gemini not to narrate its steps ("I will run…"), which were shown as visible chat output.
- The chat preamble no longer presents Pi's tools as "Available tools". It lists them as tools Pi's instructions may name and tells Gemini it cannot call them in this session, so Gemini uses its own tools instead of trying to call Pi's.
- `scripts/develop.sh` now honors `PI_CODING_AGENT_DIR` when locating Pi's global extensions directory, falling back to `~/.pi/agent/extensions`. Previously the dev symlink was always created under `~/.pi/agent/extensions` and was never loaded by Pi running with a custom agent dir.
- Forward the host git identity (`GIT_AUTHOR_*` / `GIT_COMMITTER_*`, resolved from the environment or from `git config user.name` / `user.email` as effective in the chat's working directory, so repository-local and `includeIf` identities are honored) to the spawned Gemini ACP process. The identity is part of the warm-process cache key, so a process is never reused in a repository with a different identity. Gemini CLI's sandboxed shell strips all git configuration, so `git commit` run by the agent previously failed with "Author identity unknown".

## [0.13.2] - 2026-05-30

### Fixed

- Properly tear down prewarm on `session_shutdown`: abort any in-flight prewarm subprocess via `AbortController` and cancel the pending schedule handle so the Node.js event loop drains cleanly. Fixes `pi -p` hanging after completion when this extension is loaded (earendil-works/pi#4617).
- `scheduleGeminiSearchPrewarm()` now returns a cancel function and `PrewarmScheduleHandle` gains an optional `cancel()` method so callers can clear the timer before it fires.

## [0.13.1] - 2026-05-19

### Changed

- Remove unavailable `gemini-3.1-flash-preview` from curated model choices; `flash` alias now resolves to `gemini-3.1-flash-lite-preview`.
- API-key fallback default changed from `gemini-3.1-flash-preview` to `gemini-3.1-flash-lite-preview`.
- Extract inline account-pool error classification into shared `error-classifier.ts` (`classifyGeminiError`, `isRetryableOnSameAccount`, `cooldownMs`).
- Warm ACP subprocess cleanup wired to Pi `session_shutdown` lifecycle event and `disconnect` hook.

### Fixed
- Merge caller + JSON early-stop AbortSignals in `CachedGeminiAcpClient` so Esc cancels in-flight ACP searches without killing the warm process. Previously the caller signal was dropped and early-stop aborts were silently swallowed.
- Kill entire ACP process group (wrapper + its Node child) in `JsonRpcStdioClient.close()` via SIGTERM → SIGKILL escalation, preventing orphaned `--max-old-space-size=8192` children.

## [0.13.0] - 2026-05-17

### Added

- **Multi-account failover:** configure multiple authenticated Gemini CLI accounts under `providers.accounts`; when one account hits quota exhaustion the extension transparently retries on the next healthy account.
- `AccountPool` class with per-account cooldown tracking, same-account retry on configured HTTP codes (default: 429), and immediate failover on other errors.
- Quota reset duration parsing from Gemini error messages (for example, `reset after 2h21m46s`) for precise cooldowns, with `coolDownSeconds` as fallback.
- File-backed cooldown persistence in `~/.pi/gemini-acp/config/account-cooldowns.json`, so failover state survives across tool invocations and chat turns.
- `gemini_status` account-pool output showing active account count and cooled-down accounts with remaining minutes.
- README documentation for multi-account failover, expected Gemini ACP process shape, and supported nested `pi -p ...` prompt-mode batch-worker usage from Gemini terminal sessions.

### Fixed

- Prevent recursive ACP spawning when Gemini autonomously invokes `pi` subcommands via its `run_shell_command` tool. Nested Gemini-spawned Pi processes are detected with `GEMINI_CLI=1`; tools and commands still register, but ACP-spawning activation paths are skipped.
- Restore `retries` semantics to match the design and README: `retries: N` means N extra attempts after the initial try (N+1 total) before failover.
- Preserve the underlying cause on `AccountPoolExhaustedError`, so prompt/search errors keep the upstream diagnostic instead of collapsing to a generic exhausted-pool error.
- Route chat turns through account-pool failover instead of using one pre-built provider client forever.
- Expand `~/`, `$VAR`, and `%VAR%` in account `env` values before passing them to Gemini CLI child processes.
- Treat account-entry `env` as optional; omitting it uses Gemini CLI's default credentials location.
- Fail over to the next configured account when account-specific auth preflight fails for prompt or search workflows.

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

[Unreleased]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.12.0...v0.13.0
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
