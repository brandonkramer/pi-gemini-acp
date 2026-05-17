# pi-gemini-acp

Gemini ACP chat, prompt, search, and research provider for Pi.

`pi-gemini-acp` adds a compact Gemini ACP tool surface — status, supplied-text tasks, search, research, file/image analysis, stored results, recall — and registers Gemini ACP as a selectable Pi chat model. Local/no-key search over supplied documents still works without Gemini.

## Install

```bash
pi install npm:pi-gemini-acp
```

> If your global npm prefix is system-owned, you may need to fix your npm setup or use sudo:
>
> ```bash
> sudo pi install npm:pi-gemini-acp
> ```

### Install from local source

If you have a local clone and want to run directly from source, run from inside the repo directory — no `sudo` needed, no build step:

```bash
pi install .
```

### Update local source installation

Just re-run from the repo directory:

```bash
pi install .
```

### Switch from npm to local source

Remove the npm version first to avoid tool conflicts, then install from source:

```bash
sudo pi uninstall npm:pi-gemini-acp
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

| Model id                        | Picker label                  | Aliases                                                          |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `gemini-3.1-pro-preview`        | Gemini 3.1 Pro Preview        | `pro`, `3.1-pro`, `3.1-pro-preview`, `pro-preview`               |
| `gemini-3.1-flash-preview`      | Gemini 3.1 Flash Preview      | `flash`, `3.1-flash`, `3.1-flash-preview`, `flash-preview`       |
| `gemini-3-flash-preview`        | Gemini 3 Flash Preview        | `3-flash`, `3-flash-preview`                                     |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash-Lite Preview | `flash-lite`, `lite`, `3.1-flash-lite`, `3.1-flash-lite-preview` |
| `gemini-3-pro-preview`          | Gemini 3 Pro Preview          | `3-pro`, `3-pro-preview`                                         |
| `gemini-2.5-pro`                | Gemini 2.5 Pro                | `2.5-pro`                                                        |
| `gemini-2.5-flash`              | Gemini 2.5 Flash              | `2.5-flash`                                                      |
| `gemini-2.5-flash-lite`         | Gemini 2.5 Flash-Lite         | `2.5-flash-lite`                                                 |
| `gemini-2.0-flash`              | Gemini 2.0 Flash              | `2.0-flash`                                                      |

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
```

Use `/gemini-config` with no arguments for the interactive picker. Custom command settings are saved to `~/.pi/gemini-acp/config/settings.json`.

### Safety notes

- Use Gemini CLI local auth; do not pass API keys to `/gemini-config command`.
- `permissions` gates ACP filesystem/terminal access.
- Filesystem write and terminal access require `confirmRisk=true`.
- Use `/gemini-config trust` only when Gemini CLI requires workspace trust.

### Environment overrides

```bash
export PI_GEMINI_ACP_COMMAND=gemini
export PI_GEMINI_ACP_ARGS="--acp"
export PI_GEMINI_ACP_IDLE_TTL_MS=900000
export PI_GEMINI_ACP_NO_PREWARM=1
export PI_GEMINI_ACP_SEARCH_EARLY_STOP=1 # optional: opt into streamed JSON early-stop
export PI_GEMINI_ACP_SEARCH_PARALLEL=1 # optional: opt into parallel live searches
export PI_GEMINI_ACP_CACHE=0 # optional: disable persistent response cache
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

Environment variables take precedence over `settings.json` values. The model used for API key fallback is the same model configured for ACP (via `/gemini-model` or tool parameters), defaulting to `gemini-3.1-flash-preview` if none is set.

### Runtime behavior

- **Search:** defaults to 4 results. Live ACP searches are serialized and wait for the full turn; opt into parallel calls (`PI_GEMINI_ACP_SEARCH_PARALLEL=1`) or streamed early-stop (`PI_GEMINI_ACP_SEARCH_EARLY_STOP=1`).
- **ACP sessions:** prompts and search reuse warm subprocesses for 15 minutes. Extension activation prewarms one prompt session for the Pi chat provider and one neutral search session (`PI_GEMINI_ACP_NO_PREWARM=1` disables search prewarm; prompt prewarm is skipped automatically in Gemini-spawned subprocesses).
- **Streaming UI:** Gemini-backed calls surface backend-wait/first-token progress and a `~N tokens · ~$X` cost estimate on the completed title row (informational, may not match billing).
- **Cache & recall:** successful responses are stored in `~/.pi/gemini-acp/cache.db` + `results/`. Pass `bypassCache: true` to force a live call; `gemini_ask` prompt tasks and `gemini_research` only read cache when `useCache: true`. `gemini_search` and `gemini_research` accept `useRecall: true` / `bypassRecall: true` — exact cache hits win first, recall reuse is marked with similarity, age, and `responseId`. `gemini_results` with `action: "recall"` searches the local SQLite FTS5 query cache; vector/semantic recall is currently disabled.
- **Stored result retrieval:** `gemini_results({ action: "get", responseId })` now defaults to an agent-friendly overview with summary, source notes, quality signals, and continuation actions. Use `view: "source"` plus `sourceId` for bounded source pages or `view: "raw"` with `cursor` for diagnostic JSON chunks.
- **Analyze:** `kind: "file"` and `kind: "image"` require explicit validated paths, filesystem-read permission, and a per-request allowlist. Base64 image inputs are validation-only.
- **API-key fallback:** when `GEMINI_API_KEY` is set, `gemini_search`, `gemini_research`, and `gemini_ask` fall back to the Gemini REST API if ACP is unavailable or reports quota exhaustion (cached per model, rechecked at reset or hourly). File and image analysis still require ACP.
- **Local/no-key mode** only works over supplied documents/sources. Neutral cwd is used unless project context is required.

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
- `appendTools` (default `true`) — lists active Pi tools.

Set any flag to `false` in `~/.pi/gemini-acp/config/settings.json` to suppress that section.

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
