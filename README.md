# pi-gemini-acp

Gemini ACP prompt, search, and research provider for Pi.

`pi-gemini-acp` adds Gemini ACP tools for prompt, search, research, extraction, summarization, code review, translation, and status while preserving local/no-key search over supplied documents.

## Install

```bash
pi install npm:pi-gemini-acp
```

## Requirements

- Node.js `>=22.18.0`
- Pi `>=0.65.0`
- Local authenticated Gemini ACP, defaulting to `gemini --acp`, for Gemini-backed tools.
- `gemini_file_analyze` requires ACP filesystem-read permission and passes only validated explicit local files as resource links; `gemini_image_describe` still validates inputs only until ACP image transport is confirmed.

## Tools

| Tool                    | Description                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini_status`         | Report read-only Gemini ACP command/auth/capability status after applying the same default `gemini --acp` settings used by provider search.               |
| `gemini_prompt`         | Send a general prompt to configured/authenticated Gemini ACP; does not require search grounding and has no local/no-key fallback.                         |
| `gemini_extract`        | Extract structured JSON from supplied content using configured/authenticated Gemini ACP and a supported JSON-schema-like shape.                           |
| `gemini_summarize`      | Summarize one supplied content item or one safe public HTTP(S) URL; does not perform research or multi-source synthesis.                                  |
| `gemini_search`         | Run structured search through configured Gemini ACP, or local documents when supplied.                                                                    |
| `gemini_research`       | Run Gemini ACP-backed research with source/citation tracking. Can optionally hydrate missing source text via safe direct fetch.                           |
| `gemini_file_analyze`   | Analyze explicit local text/document files through Gemini ACP resource links after conservative path validation and filesystem-read permission preflight. |
| `gemini_code_review`    | Analyze caller-provided code, diffs, or excerpts with Gemini ACP. Analysis-only; it does not read paths, edit files, or apply fixes.                      |
| `gemini_translate`      | Translate/localize single text or ordered batches with glossary/preservation constraints through configured/authenticated Gemini ACP.                     |
| `gemini_image_describe` | Validate explicit PNG/JPEG/WebP/GIF inputs and report unsupported Gemini ACP image capability until image transport is confirmed.                         |
| `gemini_get_result`     | Retrieve stored full output by `responseId`.                                                                                                              |

## Commands

| Command          | Description                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/gemini-config` | Choose `status` for a read-only command/auth/search-grounding/model/permission report, `command` to configure the local ACP command/args, `permissions` to show/modify ACP capability toggles, or `trust` to confirm Gemini CLI workspace trust for ACP sessions. |
| `/gemini-model`  | Show selectable Gemini model choices, accept aliases such as `pro` or `flash`, and persist a preferred model after confirming the configured ACP command advertises model selection.                                                                              |

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

With authenticated, search-capable `gemini --acp`, Gemini-backed tools work from the default config. Use `/gemini-config` to inspect status, edit the ACP command/args, manage permissions, or confirm workspace trust. Interactive Pi opens picker UIs; `/gemini-config command` stages command/arg edits before saving custom settings to `~/.pi/gemini-acp/config/settings.json`.

```bash
/gemini-config
/gemini-config status
/gemini-config command
/gemini-config command gemini --acp
/gemini-config command /opt/homebrew/bin/gemini --acp --model gemini-2.5-flash
/gemini-config permissions
/gemini-config permissions filesystemRead
/gemini-config permissions filesystemWrite true confirmRisk=true reason="modify generated docs"
/gemini-config trust
```

Do not pass API keys/tokens to `/gemini-config command`; use Gemini CLI local auth. `permissions` controls ACP filesystem/terminal access, and write/terminal access requires `confirmRisk=true`. `/gemini-config trust` explains why Gemini ACP needs a working folder for local sessions and, after confirmation, adds Gemini CLI `--skip-trust` to avoid untrusted-folder diagnostics corrupting ACP JSON-RPC stdout.

You can also override the command with environment variables:

```bash
export PI_GEMINI_ACP_COMMAND=gemini
export PI_GEMINI_ACP_ARGS="--acp"
export PI_GEMINI_ACP_IDLE_TTL_MS=900000
```

Search, prompt, and research source collection reuse warm ACP subprocesses for up to 15 minutes of idle time by default; set `PI_GEMINI_ACP_IDLE_TTL_MS` to a positive millisecond value to override it. The idle timer is `unref()`'d, so it does not keep Pi/Node running by itself. `gemini_prompt` still uses a fresh ACP session per prompt. Prompt/search sessions use a neutral working directory unless a workflow explicitly supplies a project cwd, so project trust is only triggered when project context is needed. Local/no-key mode is limited to supplied documents/sources for search/research. `gemini_file_analyze` validates explicit files under `cwd`, rejects hidden/secret-like/symlink/directory inputs, requires filesystem-read permission, and uses ACP resource links with a per-request read allowlist. `gemini_image_describe` only validates inputs until ACP image transport is confirmed.

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
npm pack --dry-run --json
```

`smoke:gemini-acp` skips by default unless `PI_GEMINI_ACP=1` is set.

## License

[MIT](LICENSE)
