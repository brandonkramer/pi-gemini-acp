# pi-gemini-acp

Gemini ACP prompt, search, and research provider for Pi.

`pi-gemini-acp` adds a compact Gemini ACP tool surface for status, supplied-text tasks, search, research, local file/image analysis, stored results, and recall while preserving local/no-key search over supplied documents.

## Install

```bash
pi install npm:pi-gemini-acp
```

## Requirements

- Node.js `>=22.18.0`
- Pi `>=0.65.0`
- Local authenticated Gemini ACP (`gemini --acp` by default) for Gemini-backed tools.
- `gemini_analyze` needs filesystem-read permission for local files/images, only reads explicit validated paths, and prompts before trusting a new folder when Pi is interactive.
- Image analysis requires confirmed ACP image/resource-link support for local image paths; base64 inputs are validation-only.

## Tools

| Tool              | Description                                                             | Description tokens ≈ | Input overhead ≈ |
| ----------------- | ----------------------------------------------------------------------- | -------------------: | ---------------: |
| `gemini_status`   | Check Gemini ACP command, auth, and capability status.                  |                    8 |              +35 |
| `gemini_ask`      | Prompt, extract, summarize, translate, or code-review supplied text.    |                   10 |             +184 |
| `gemini_search`   | Search with Gemini ACP, or search supplied local documents without ACP. |                   16 |             +104 |
| `gemini_research` | Collect sources, findings, citations, and optional safe hydration.      |                   17 |             +127 |
| `gemini_analyze`  | Analyze explicit local files/images via validated ACP resource links.   |                   19 |             +115 |
| `gemini_results`  | Retrieve stored outputs or search local SQLite FTS recall.              |                    7 |             +110 |

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

Environment variables take precedence over `settings.json` values. The model used for API key fallback is the same model configured for ACP (via `/gemini-model` or tool parameters), defaulting to `gemini-1.5-flash` if none is set.

### Runtime behavior

- `gemini_search` defaults to 4 results for the best observed latency/quality tradeoff.
- Warm ACP subprocesses are reused for 15 minutes by default.
- Search prewarms on activation unless `PI_GEMINI_ACP_NO_PREWARM=1`; `gemini_status` reports the latest prewarm state.
- Search waits for the full turn by default; set `PI_GEMINI_ACP_SEARCH_EARLY_STOP=1` to opt into streamed JSON early-stop.
- Live Gemini ACP searches are serialized by default; set `PI_GEMINI_ACP_SEARCH_PARALLEL=1` to opt into parallel calls.
- Prompt calls still use fresh ACP sessions.
- Gemini-backed prompt, search, file-analysis, and image-analysis calls surface real backend-wait and first-token progress when Pi provides streaming updates.
- Completed Gemini tool title rows include an approximate token and USD cost label, for example `✓ gemini_search · ~256 tokens · ~$0.035`. Estimates use a lightweight character-based token approximation, configured model pricing, and search grounding surcharge where applicable; they are informational and may not match provider billing exactly.
- Neutral cwd is used unless project context is required.
- Local/no-key mode only works over supplied documents/sources.
- Cacheable Gemini tools store successful responses in `~/.pi/gemini-acp/cache.db` + `results/`; pass `bypassCache: true` to force a live call. `gemini_ask` prompt tasks and `gemini_research` only use cache when `useCache: true`.
- `gemini_results` with `action: "recall"` searches a local SQLite FTS5 query cache over prior Gemini results in `cache.db`; it does not require an embedding provider.
- Vector/semantic recall is disabled for now. No Gemini ACP embedding transport is used for recall queries.
- `gemini_search` and `gemini_research` accept opt-in `useRecall: true` plus `bypassRecall: true`; exact cache hits win first, and any recall-sourced reuse is visibly marked with similarity, age, and `responseId`.
- `gemini_analyze` with `kind: "file"` uses explicit validated files, filesystem-read permission, and a per-request allowlist.
- `gemini_analyze` with `kind: "image"` uses explicit validated image paths, filesystem-read permission, and a per-request allowlist; base64 inputs are validation-only.
- When `GEMINI_API_KEY` is set (env var or `settings.json`), `gemini_search`, `gemini_research`, and `gemini_ask` automatically fall back to the Gemini REST API if local ACP is unavailable (missing command, unauthenticated, or search grounding not confirmed) or ACP reports quota/capacity exhaustion. ACP quota exhaustion is cached per model and rechecked after the reported reset window or after the hourly fallback window. File and image analysis still require ACP.

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

Run `/gemini-model` for the picker, or pass an alias/model id directly.

```bash
/gemini-model
/gemini-model pro
/gemini-model flash
/gemini-model gemini-3.1-pro-preview
```

Aliases include `pro`, `flash`, `flash-lite`, `lite`, and compatible versioned aliases such as `2.5-pro`.

## Model adapter for pi-scraper

Install `pi-gemini-acp` alongside [`pi-scraper`](https://github.com/brandonkramer/pi-scraper) and pi-scraper's `web_summarize` tool will use Gemini ACP automatically. No configuration needed.

pi-gemini-acp lends its Gemini ACP client to pi-scraper at extension load via the `pi:model-adapter/*` event protocol.

### What you get

| Installed            | `web_summarize` behavior                                      |
| -------------------- | ------------------------------------------------------------- |
| Both                 | Returns Gemini-backed summaries automatically                 |
| Only `pi-gemini-acp` | No effect — adapter registers, no listener consumes the event |
| Only `pi-scraper`    | Falls back to `web_scrape` + summarize-in-reply               |

### Adapter details

| Property     | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| Adapter id   | `gemini-acp`                                                      |
| Label        | `Gemini (via ACP)`                                                |
| Capabilities | `["summarize"]`                                                   |
| Priority     | `50`                                                              |
| Backend      | Local authenticated Gemini ACP — same client as `gemini_ask`      |
| Cold start   | Lazy — ACP session opens on first invocation, not at registration |

### Disable

```bash
PI_GEMINI_ACP_OFFER_MODEL_ADAPTER=0
```

When set, pi-gemini-acp skips registration. Use this to keep your Gemini quota for first-party tools, or to let a higher-priority adapter handle `web_summarize` exclusively.

### Verify

`gemini_status` reports the live registration state:

```json
{
  "modelAdapter": {
    "offered": true,
    "capabilities": ["summarize"],
    "priority": 50
  }
}
```

`offered: true` means the `pi:model-adapter/register` event was actually emitted — not just that the env var allowed it. `/gemini-config status` shows the same info as a one-line "Model adapter offered" entry.

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
