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

| Tool              | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `gemini_status`   | Check Gemini ACP command, auth, and capability status.                  |
| `gemini_ask`      | Prompt, extract, summarize, translate, or code-review supplied text.    |
| `gemini_search`   | Search with Gemini ACP, or search supplied local documents without ACP. |
| `gemini_research` | Collect sources, findings, citations, and optional safe hydration.      |
| `gemini_analyze`  | Analyze explicit local files/images via validated ACP resource links.   |
| `gemini_results`  | Retrieve stored outputs or search local SQLite FTS recall.              |

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
export PI_GEMINI_ACP_SEARCH_EARLY_STOP=0
export PI_GEMINI_ACP_CACHE=0 # optional: disable persistent response cache
export PI_GEMINI_ACP_RECALL=0 # optional: disable recall tool registration and FTS recall
```

### Runtime behavior

- Warm ACP subprocesses are reused for 15 minutes by default.
- Search prewarms on activation unless `PI_GEMINI_ACP_NO_PREWARM=1`.
- Search can cancel after complete streamed JSON unless `PI_GEMINI_ACP_SEARCH_EARLY_STOP=0`.
- Prompt calls still use fresh ACP sessions.
- Neutral cwd is used unless project context is required.
- Local/no-key mode only works over supplied documents/sources.
- Cacheable Gemini tools store successful responses in `~/.pi/gemini-acp/cache.db` + `results/`; pass `bypassCache: true` to force a live call. `gemini_ask` prompt tasks and `gemini_research` only use cache when `useCache: true`.
- `gemini_results` with `action: "recall"` searches a local SQLite FTS5 query cache over prior Gemini results in `cache.db`; it does not require an embedding provider.
- Vector/semantic recall is disabled for now. No Gemini ACP embedding transport is used for recall queries.
- `gemini_search` and `gemini_research` accept opt-in `useRecall: true` plus `bypassRecall: true`; exact cache hits win first, and any recall-sourced reuse is visibly marked with similarity, age, and `responseId`.
- `gemini_analyze` with `kind: "file"` uses explicit validated files, filesystem-read permission, and a per-request allowlist.
- `gemini_analyze` with `kind: "image"` uses explicit validated image paths, filesystem-read permission, and a per-request allowlist; base64 inputs are validation-only.

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
