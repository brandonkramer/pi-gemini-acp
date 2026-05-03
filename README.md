# pi-gemini-acp

Gemini ACP prompt, search, and research provider for Pi.

`pi-gemini-acp` owns the optional Gemini ACP subprocess/runtime integration so other Pi extensions can stay local-first. It exposes standalone Gemini-backed prompt, extraction, summarization, search, research, code review, translation, and status tools while keeping local/no-key search over supplied documents available for tests and offline workflows.

## Install

```bash
pi install npm:pi-gemini-acp
```

## Requirements

- Node.js `>=22.18.0`
- Pi `>=0.65.0`
- A locally installed/authenticated Gemini ACP command for real Gemini-backed prompt, extract, summarize, search, research, code review, and translation tools. By default, the extension runs `gemini --acp`.
- Local file/document and image analysis are capability-gated. `gemini_file_analyze` and `gemini_image_describe` currently validate explicit inputs and return unsupported-capability errors until Gemini ACP file/document/image input support is confirmed and safely wired.

## Tools

| Tool                    | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini_status`         | Report read-only Gemini ACP command/auth/capability status after applying the same default `gemini --acp` settings used by provider search. |
| `gemini_prompt`         | Send a general prompt to configured/authenticated Gemini ACP; does not require search grounding and has no local/no-key fallback.           |
| `gemini_extract`        | Extract structured JSON from supplied content using configured/authenticated Gemini ACP and a supported JSON-schema-like shape.             |
| `gemini_summarize`      | Summarize one supplied content item or one safe public HTTP(S) URL; does not perform research or multi-source synthesis.                    |
| `gemini_search`         | Run structured search through configured Gemini ACP, or local documents when supplied.                                                      |
| `gemini_research`       | Run Gemini ACP-backed research with source/citation tracking. Can optionally hydrate missing source text via safe direct fetch.             |
| `gemini_file_analyze`   | Validate explicit local file paths for future Gemini ACP file/document analysis, then return unsupported until ACP file input is confirmed. |
| `gemini_code_review`    | Analyze caller-provided code, diffs, or excerpts with Gemini ACP. Analysis-only; it does not read paths, edit files, or apply fixes.        |
| `gemini_translate`      | Translate/localize single text or ordered batches with glossary/preservation constraints through configured/authenticated Gemini ACP.       |
| `gemini_image_describe` | Validate explicit PNG/JPEG/WebP/GIF inputs and report unsupported Gemini ACP image capability until image transport is confirmed.           |
| `gemini_get_result`     | Retrieve stored full output by `responseId`.                                                                                                |

## Commands

| Command          | Description                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/gemini-config` | Choose `status` for a read-only command/auth/search-grounding/model/permission report, `command` to configure the local ACP command/args, or `permissions` to show/modify ACP capability toggles. |
| `/gemini-model`  | Show selectable Gemini model choices, accept aliases such as `pro` or `flash`, and persist a preferred model after confirming the configured ACP command advertises model selection.              |

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

With authenticated, search-capable `gemini --acp`, Gemini-backed tools work from the default config. Search, prompt, and research source collection reuse short-lived warm ACP subprocesses; `gemini_prompt` still uses a fresh ACP session per prompt so prompts stay isolated. Override the command with environment variables when needed:

```bash
export PI_GEMINI_ACP_COMMAND=gemini
export PI_GEMINI_ACP_ARGS="--acp"
```

Custom settings live in `~/.pi/gemini-acp/config/settings.json`. Local/no-key mode is limited to supplied documents/sources for search/research; prompt, extract, summarize, code review, and translation require configured Gemini ACP. `gemini_file_analyze` and `gemini_image_describe` only validate explicit inputs and return unsupported-capability errors until ACP file/image transport is confirmed.

Use `/gemini-config` to inspect status, edit the ACP command/args, or manage permissions. Interactive Pi opens picker UIs; `/gemini-config command` stages command/arg edits before saving.

```bash
/gemini-config
/gemini-config status
/gemini-config command
/gemini-config command gemini --acp
/gemini-config command /opt/homebrew/bin/gemini --acp --model gemini-2.5-flash
/gemini-config permissions
/gemini-config permissions filesystemRead
/gemini-config permissions filesystemWrite true confirmRisk=true reason="modify generated docs"
```

Do not pass API keys/tokens to `/gemini-config command`; use Gemini CLI local auth. `permissions` controls ACP filesystem/terminal access, and write/terminal access requires `confirmRisk=true`.

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
