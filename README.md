# pi-gemini-acp

Gemini ACP chat, prompt, search, and research provider for Pi.

`pi-gemini-acp` adds a compact Gemini ACP tool surface — status, supplied-text tasks, search, research, file/image analysis, stored results, recall — and registers Gemini ACP as a selectable Pi chat model. Local/no-key search over supplied documents still works without Gemini.

## Note: Gemini CLI cold starts can be slow

First use after Pi starts, reloads, or warm-process cleanup may take several seconds while `gemini --acp` boots and creates a session. This is largely upstream Gemini CLI behavior; see google-gemini/gemini-cli [#10726](https://github.com/google-gemini/gemini-cli/issues/10726), [#22157](https://github.com/google-gemini/gemini-cli/pull/22157), and [#20700](https://github.com/google-gemini/gemini-cli/pull/20700). `pi-gemini-acp` keeps sessions warm when possible.

## Install

```bash
pi install npm:pi-gemini-acp
```

> If your global npm prefix is system-owned, prefix with `sudo`:
>
> ```bash
> sudo pi install npm:pi-gemini-acp
> ```

### Local development

```bash
cd pi-gemini-acp
./scripts/develop.sh link   # symlink into Pi
./scripts/develop.sh unlink # restore npm version
```

Or install from source:

```bash
cd pi-gemini-acp
pi install .
```

## Requirements

- Node.js `>=22.18.0`
- Pi `>=0.65.0`
- Local authenticated Gemini ACP (`gemini --acp` by default) for Gemini-backed tools.
- `gemini_analyze` needs filesystem-read permission for local files/images, only reads explicit validated paths, and prompts before trusting a new folder when Pi is interactive.
- Image analysis requires confirmed ACP image/resource-link support for local image paths; base64 inputs are validation-only.

## Chat models

When the ACP command is configured and `gemini_status` reports ready, the extension calls `pi.registerProvider("gemini-acp", ...)` and registers the following models in Pi's chat model picker.

| Model id                        | Picker label                  | Aliases                                                                                    |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `gemini-3.1-pro-preview`        | Gemini 3.1 Pro Preview        | `pro`, `3.1-pro`, `3.1-pro-preview`, `pro-preview`                                         |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash-Lite Preview | `flash`, `flash-preview`, `flash-lite`, `lite`, `3.1-flash-lite`, `3.1-flash-lite-preview` |
| `gemini-3-flash-preview`        | Gemini 3 Flash Preview        | `3-flash`, `3-flash-preview`                                                               |
| `gemini-3-pro-preview`          | Gemini 3 Pro Preview          | `3-pro`, `3-pro-preview`                                                                   |
| `gemini-2.5-pro`                | Gemini 2.5 Pro                | `2.5-pro`                                                                                  |
| `gemini-2.5-flash`              | Gemini 2.5 Flash              | `2.5-flash`                                                                                |
| `gemini-2.5-flash-lite`         | Gemini 2.5 Flash-Lite         | `2.5-flash-lite`                                                                           |
| `gemini-2.0-flash`              | Gemini 2.0 Flash              | `2.0-flash`                                                                                |

## Tools

| Tool              | Description                                                             | Contract tokens ≈ | Input tokens ≈ |
| ----------------- | ----------------------------------------------------------------------- | ----------------: | -------------: |
| `gemini_status`   | Check Gemini ACP command, auth, and capability status.                  |                30 |              9 |
| `gemini_ask`      | Prompt, extract, summarize, translate, or code-review supplied text.    |               154 |            131 |
| `gemini_search`   | Search with Gemini ACP, or search supplied local documents without ACP. |               127 |             98 |
| `gemini_research` | Collect sources, findings, citations, and optional safe hydration.      |               154 |            123 |
| `gemini_analyze`  | Analyze explicit local files/images via validated ACP resource links.   |               130 |             98 |
| `gemini_results`  | Retrieve stored outputs or search local SQLite FTS recall.              |               108 |             87 |

Contract tokens count the serialized tool schema (name + description + parameters); input tokens count the parameters schema alone. Both use the same `chars/4` approximation as the runtime cost estimator.

## Commands

- `/gemini-config` — inspect status, configure command args, manage permissions, confirm workspace trust, manage the response cache, or toggle local recall.
- `/gemini-model` — choose and persist a Gemini model or alias such as `pro` or `flash`.

## Configuration

The default Gemini ACP provider config is:

```json
{
	"enabled": true,
	"command": "gemini",
	"args": ["--acp"],
	"authenticated": true,
	"searchGroundingAvailable": true
}
```

With authenticated, search-capable `gemini --acp`, Gemini-backed tools work from the default config.

### Common commands

```bash
/gemini-config status
/gemini-config command gemini --acp
/gemini-config permissions filesystemRead
/gemini-config trust
/gemini-config cache status
/gemini-config cache clear --tool gemini_search
/gemini-config recall disable
/gemini-config recall enable
/gemini-config search status
/gemini-config search disable
/gemini-config search enable
```

Use `/gemini-config` with no arguments for the interactive picker. Custom command settings are saved to `~/.pi/gemini-acp/config/settings.json`.

All tools registered by this extension (`gemini_*`) are exposed only when the selected model is Gemini, including Gemini models through other providers. Switching models updates tool visibility without changing unrelated tools. Slash commands remain available for every model.

The interactive picker includes a Search tool section. Search is enabled by default; disabling it saves `searchEnabled: false` in settings. Changes apply before the next model request. `PI_GEMINI_ACP_SEARCH=0` overrides the saved setting.

### Safety notes

- Use Gemini CLI local auth; do not pass API keys to `/gemini-config command`.
- `permissions` controls the answers to Gemini's ACP permission requests, not a filesystem or shell sandbox. Gemini CLI approval settings can allow operations without asking this extension: when a chat session runs in Gemini's `autoEdit` or `yolo` approval mode, the chat shows a warning that the policy is not applied.
- The client does not advertise filesystem-write or terminal services. Gemini executes writes and commands locally using its own tools; this avoids routing writes to an unimplemented `fs/write_text_file` handler.
- Filesystem write and terminal access require `confirmRisk=true`.
- Use `/gemini-config trust` only when Gemini CLI requires workspace trust.

### Environment overrides

```bash
export PI_GEMINI_ACP_COMMAND=gemini
export PI_GEMINI_ACP_ARGS="--acp"
export PI_GEMINI_ACP_IDLE_TTL_MS=900000
export PI_GEMINI_ACP_NO_PREWARM=1 # disables both chat and search prewarm
export PI_GEMINI_ACP_STARTUP_TIMEOUT_MS=60000 # deadline per initialize/session-new request
export PI_GEMINI_ACP_PROMPT_TIMEOUT_MS=1800000 # total deadline per ACP prompt
export PI_GEMINI_ACP_PROMPT_IDLE_TIMEOUT_MS=600000 # cancel a prompt with no progress for this long (0 disables)
export PI_GEMINI_ACP_TOOL_TIMEOUT_MS=600000 # cancel a prompt when one Gemini tool call runs this long (0 disables)
export PI_GEMINI_ACP_MAX_PROMPT_SESSIONS=25 # restart the warm chat process after this many turns
export PI_GEMINI_ACP_MAX_SESSION_INPUT_TOKENS=600000 # stop continuing a chat session past this many input tokens
export PI_GEMINI_ACP_SEARCH_EARLY_STOP=0 # optional: opt out of streamed JSON early-stop (enabled by default)
export PI_GEMINI_ACP_SEARCH_PARALLEL=0 # optional: opt out of parallel live searches (enabled by default)
export PI_GEMINI_ACP_CACHE=0 # optional: disable persistent response cache
export PI_GEMINI_ACP_SEARCH=0 # optional: disable gemini_search
export PI_GEMINI_ACP_RECALL=0 # optional: disable recall tool registration and FTS recall
export GEMINI_API_KEY=your_api_key_here # optional: fallback when ACP is unavailable
```

Or persist the API key in `~/.pi/gemini-acp/config/settings.json`:

```json
{
	"providers": {
		"gemini-acp": {
			"apiKey": "your_api_key_here"
		}
	}
}
```

Environment variables take precedence over `settings.json` values. The model used for API key fallback is the same model configured for ACP (via `/gemini-model` or tool parameters), defaulting to `gemini-3.1-flash-lite-preview` if none is set.

### Runtime behavior

- **Search:** defaults to 4 results. Live ACP searches run in parallel and stop early once a complete JSON result array is streamed (both enabled by default). Use `PI_GEMINI_ACP_SEARCH_PARALLEL=0` to serialize, or `PI_GEMINI_ACP_SEARCH_EARLY_STOP=0` to wait for the full turn.
- **ACP sessions:** subprocesses stay warm for 15 idle minutes. A chat continues the Gemini session that already holds its earlier messages and sends only the new ones (the latest request, plus any messages from other models in between). After a branch switch, compaction, a change of model, system prompt or working directory, a failed or aborted turn, or a process restart, the turn starts a fresh session with the whole history. Gemini CLI keeps its own tool calls and their output in the session, so a continued session can grow well past the history Pi sends. Once a turn reports 600,000 input tokens or more (`PI_GEMINI_ACP_MAX_SESSION_INPUT_TOKENS`), the next turn starts a fresh session instead. If Gemini still rejects a continued session as larger than its input limit before answering, the turn is retried once on a fresh session. The chat prewarm starts when a session starts or the model changes, and only when a Gemini ACP model is selected, so it uses the same model as the first turn. ACP cannot end a session, so the warm process is restarted once idle after 25 fresh sessions (`PI_GEMINI_ACP_MAX_PROMPT_SESSIONS`) to keep abandoned ones from accumulating in memory. Search sessions remain reusable. `PI_GEMINI_ACP_NO_PREWARM=1` disables both chat and search prewarm.
- **Deadlines:** initialization and session creation each have a 60-second deadline; prompts have a 30-minute total deadline, long enough for agentic edit/test loops. A prompt that sends no progress (answer text, thoughts, tool or permission updates) for 10 minutes while none of Gemini's tools is running is treated as stalled and cancelled; a long-running build or test does not count. A single Gemini tool call (a shell command, a web search stuck in server-side retries) may run for 10 minutes; after that the whole turn is cancelled, since ACP cannot cancel one tool call. Positive millisecond overrides are shown above. A timeout invalidates the connection. Transport failures and timeouts do not trigger account retries or failover, since an action may already have completed. Check the working tree or remote state before retrying.
- **Streaming UI:** Gemini-backed calls surface backend-wait/first-token progress and a `~N tokens · ~$X` cost estimate on the completed title row (informational, may not match billing).
- **Chat usage:** chat turns report the token counts Gemini CLI returns, priced for the model that served the turn (with `gemini-auto`, Flash or Pro). The price table is informational and may not match billing.
- **Cache & recall:** successful responses are stored in `~/.pi/gemini-acp/cache.db` + `results/`. Pass `bypassCache: true` to force a live call; `gemini_ask` prompt tasks and `gemini_research` only read cache when `useCache: true`. `gemini_search` and `gemini_research` accept `useRecall: true` / `bypassRecall: true` — exact cache hits win first, recall reuse is marked with similarity, age, and `responseId`. `gemini_results` with `action: "recall"` searches the local SQLite FTS5 query cache; vector/semantic recall is currently disabled.
- **Stored result retrieval:** `gemini_results({ action: "get", responseId })` now defaults to an agent-friendly overview with summary, source notes, quality signals, and continuation actions. Use `view: "source"` plus `sourceId` for bounded source pages or `view: "raw"` with `cursor` for diagnostic JSON chunks.
- **Analyze:** `kind: "file"` and `kind: "image"` require explicit validated paths, filesystem-read permission, and a per-request allowlist. Base64 image inputs are validation-only.
- **API-key fallback:** when `GEMINI_API_KEY` is set, `gemini_search`, `gemini_research`, and `gemini_ask` fall back to the Gemini REST API if ACP is unavailable or reports quota exhaustion (cached per model, rechecked at reset or hourly). File and image analysis still require ACP.
- **Local/no-key mode** only works over supplied documents/sources. Neutral cwd is used unless project context is required.

### ACP diagnostics

To investigate slow turns, opt into a local metadata-only JSONL trace:

```bash
PI_GEMINI_ACP_TRACE_FILE="$HOME/pi-gemini-acp-trace.jsonl" pi
```

The trace records timestamps, queue waits, connection/request IDs, RPC durations and error codes, submitted text size, permission classification and decisions, and update types such as `agent_thought_chunk` and `tool_call` (with the tool kind and status). Each finished Gemini tool call adds a `tool.end` record with its kind, status and duration. Each prompt turn ends with a `prompt.end` record: outcome, ACP stop reason, total duration, time to the first answer text (`firstTextMs`), and the number of tool calls, permission requests and thought chunks, plus the longest tool run (`longestToolMs`). It does not record prompt text, command arguments, paths from requests, diff/file contents, tool titles, response text, credentials, or raw error messages. Unknown method and update names are redacted. Newly created trace files have mode `0600`; existing file permissions are unchanged. Remove the file when finished, since tracing appends without rotation.

During a chat turn, Gemini's thoughts are shown as thinking text in Pi, so `hideThinkingBlock` hides them. The tools Gemini runs on its own are shown separately, like Pi's own tool calls: each finished call appears above the answer with its command, output (collapsed to the last lines; Ctrl+O expands) and duration, and Pi's working line names the call that is running. Permission requests denied by the policy appear the same way. These entries are saved in the session but never sent to a model; tool titles and output appear only there, never in the trace. The chat provider still uses Gemini's tools, not Pi's tool registry. A tool-name list in the preamble does not make Pi tools callable.

### Image description example

```json
{
	"imagePath": "/path/to/screenshot.png",
	"mode": "detailed",
	"instructions": "Describe this screenshot briefly, including visible text."
}
```

`gemini_analyze` performs runtime ACP image/resource-link capability checks even when status output reports image capability as unknown.

### Selecting a model

`/gemini-model` sets the Gemini model used by this extension's tools (`gemini_search`, `gemini_ask`, `gemini_research`, `gemini_analyze`) and the API-key fallback. It does **not** change the Pi chat model — that is selected separately from Pi's model picker.

Run `/gemini-model` for the picker, or pass an alias/model id directly.

```bash
/gemini-model
/gemini-model pro
/gemini-model flash
/gemini-model gemini-3.1-pro-preview
```

Aliases include `pro`, `flash`, `flash-lite`, `lite`, and compatible versioned aliases such as `2.5-pro`.

**Pi chat model picker:** Gemini ACP also appears as a selectable Pi chat model when the extension registers it via `pi.registerProvider()`. This requires the ACP command to be configured and available. When absent or unauthenticated, the provider is not shown. The chat model's own model choice is controlled by Pi, independent of `/gemini-model`.

### Multi-account failover

Configure multiple authenticated Gemini CLI accounts for automatic failover when one account hits quota exhaustion:

```json
{
	"providers": {
		"accounts": {
			"failover": {
				"retries": 3,
				"codes": [429],
				"coolDownSeconds": 600
			},
			"entries": [
				{
					"name": "primary"
				},
				{
					"name": "secondary",
					"env": { "GEMINI_CLI_HOME": "~/.gemini-2" }
				}
			]
		},
		"gemini-acp": {
			"enabled": true,
			"command": "gemini",
			"args": ["--acp", "--skip-trust"],
			"model": "gemini-3.1-pro-preview"
		}
	}
}
```

Each account entry points to a separate `GEMINI_CLI_HOME` with its own authenticated Gemini CLI credentials. All accounts share the `gemini-acp` provider settings (command, args, model, permissions).

**Failover behavior:**

- On HTTP 429 (or codes listed in `failover.codes`): retry the same account up to `failover.retries` times, then switch to the next healthy account.
- On other errors: switch to the next healthy account immediately.
- Quota reset time is parsed from the error message (e.g. "Your quota will reset after 2h21m46s"). If not parseable, `coolDownSeconds` is used as fallback.
- Cooldown state is persisted to `~/.pi/gemini-acp/config/account-cooldowns.json` and reloaded on each call, so failover survives across tool invocations and chat turns.
- When no accounts are configured, behavior is identical to previous versions.

**Prerequisites:** each `GEMINI_CLI_HOME` path must contain a valid authenticated Gemini CLI installation (`gemini auth login` completed under that home).

> **Note:** to use the default Gemini CLI credentials directory (`~/.gemini`), omit `env` entirely or set `GEMINI_CLI_HOME` to an empty string. Only specify `GEMINI_CLI_HOME` for accounts that use a non-default location.

`env` values support tilde expansion (`~/`), Unix env var references (`$HOME`), and Windows env var references (`%USERPROFILE%`).

Set `enabled: false` on any entry to temporarily disable an account without removing it from config.

Use `gemini_status` to see active accounts and current cooldown state.

### Known issue: recursive ACP spawn via `gemini` shell tool

When Gemini ACP is the active Pi chat model and its shell-tool permission is enabled (`terminal: true`), Gemini may autonomously invoke `pi` subcommands (most commonly `pi mcp list`) inside its `run_shell_command` tool. Each such invocation re-loads this extension in a fresh process, and a naive eager prewarm would spawn two more `gemini --acp` subprocesses (one for the chat prewarm, one for the search prewarm). Those subprocesses in turn may run shell tools again, producing an unbounded recursive process tree.

**Workaround (built-in):** Gemini CLI tags subprocesses it spawns with `GEMINI_CLI=1`. The extension detects this on activation and registers only tools/commands in that nested process. It skips every activation path that can spawn another ACP subprocess: model adapter registration, model-provider registration/auth probing, prompt/search prewarm, and cache-retention sweep. This keeps `pi mcp list` usable inside Gemini shell-tool calls without creating a recursive ACP process tree.

**Expected process shape:** in a normal top-level Pi session, it is normal to see a small fixed number of `gemini --acp` subprocesses. Startup can create one prompt-provider warm process plus one search warm process, and active chat/tool turns can add their own live ACP processes. The Gemini CLI wrapper commonly appears as a parent `node .../gemini --acp ...` process with a child `node-22 --max-old-space-size=... .../gemini --acp ...`; that parent/child pair is one logical Gemini ACP subprocess. What should not happen is unbounded nesting where a Gemini-spawned `pi` process creates another pair, which creates another pair, and so on.

**Nested Pi prompt mode:** Gemini may intentionally use terminal access to run `pi -p ...` as a non-interactive batch worker for complex workflows, such as processing one generated prompt file at a time. That is allowed and can be useful. Those nested Pi processes inherit `GEMINI_CLI=1`, so this extension skips ACP-spawning activation paths inside them. Prefer non-interactive invocations such as `PI_MODE=text pi -p "@file.txt" < /dev/null > output.md`; avoid bare interactive `pi` from inside Gemini shell commands.

TODO: add a narrow safety guard for future releases that warns on or denies bare interactive nested `pi` invocations while still allowing explicit non-interactive `pi -p ...` batch-worker calls.

To disable prewarm unconditionally (e.g. for debugging or memory-constrained hosts) set `PI_GEMINI_ACP_NO_PREWARM=1`.

### Chat preamble injection

When Gemini ACP is selected as the active Pi model, every prompt is prefixed with a Pi-aware preamble so Gemini knows it's running inside Pi, which model is active, the working directory, the project's `AGENTS.md`, and available skills. Three opt-out flags control this:

```json
{
	"providers": {
		"gemini-acp": {
			"chat": {
				"appendSystemPrompt": true,
				"appendAgents": true,
				"appendTools": true
			}
		}
	}
}
```

- `appendSystemPrompt` (default `true`) — includes the Pi identity header (`You are running inside Pi...`) and the upstream system prompt.
- `appendAgents` (default `true`) — includes the `AGENTS.md` from the working directory (capped at ~32 KB).
- `appendTools` (default `true`) — lists active Pi tools that Pi's instructions may name, and tells Gemini it cannot call them in the chat session and should use its own tools instead.

Set any flag to `false` in `~/.pi/gemini-acp/config/settings.json` to suppress that section.

`chat.maxHistoryMessages` limits the number of messages sent to a fresh Gemini session, including the current request. The default is unlimited. A value of `0` sends only the latest message. This is a message-count limit, not a token limit; one large tool result can still dominate the prompt. A continued session already holds the earlier messages, so only new messages are sent and this limit does not apply.

`chat.maxHistoryChars` is a character budget for the same fresh-session prompt, including the preamble or system prompt (default `200000`, about 50k tokens; `0` disables it). When the history is larger, tool results before the latest request are shortened to their beginning and end first, then the oldest messages are dropped with a note saying how many were left out. The latest message is always sent in full.

## Model adapter for pi-scraper

If [`pi-scraper`](https://github.com/brandonkramer/pi-scraper) is also installed, its `web_summarize` routes through Gemini automatically (adapter id `gemini-acp`, `summarize` capability, priority `50`, sharing the warm `gemini_ask` ACP client). Pin explicitly with `web_summarize({ url, provider: "gemini-acp" })`, opt out via `PI_GEMINI_ACP_OFFER_MODEL_ADAPTER=0`, and verify with `gemini_status` (`modelAdapter.offered: true`).

## Validation

```bash
npm run typecheck
npm test
npm run test:tools
npm run smoke:gemini-acp
PI_GEMINI_ACP=1 npm run smoke:gemini-acp
npm run test:pack
```

`smoke:gemini-acp` skips by default unless `PI_GEMINI_ACP=1` is set.

## License

[MIT](LICENSE)
