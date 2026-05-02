# pi-gemini-acp

Gemini ACP search and research provider for Pi.

`pi-gemini-acp` owns the optional Gemini ACP subprocess/runtime integration so other Pi extensions can stay local-first. It exposes standalone Gemini-backed search and research tools while keeping local/no-key search over supplied documents available for tests and offline workflows.

## Install

```bash
pi install npm:pi-gemini-acp
```

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.65.0`
- A locally installed/authenticated Gemini ACP command for real Gemini-backed prompt, extract, summarize, search, research, code review, and translation tools. By default, the extension runs `gemini --acp`.
- Local file/document and image analysis are capability-gated. `gemini_file_analyze` and `gemini_image_describe` currently validate explicit inputs and return unsupported-capability errors until Gemini ACP file/document/image input support is confirmed and safely wired.

## Tools

| Tool                 | Description                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini_status`      | Report read-only Gemini ACP command/auth/capability status from explicit persisted/env settings; stricter than the search default shim. |
| `gemini_prompt`      | Send a general prompt to configured/authenticated Gemini ACP; does not require search grounding and has no local/no-key fallback.       |
| `gemini_extract`     | Extract structured JSON from supplied content using configured/authenticated Gemini ACP and a supported JSON-schema-like shape.         |
| `gemini_summarize`   | Summarize one supplied content item or one safe public HTTP(S) URL; does not perform research or multi-source synthesis.                |
| `gemini_search`      | Run structured search through configured Gemini ACP, or local documents when supplied.                                                  |
| `gemini_research`    | Run Gemini ACP-backed research with source/citation tracking. Can optionally hydrate missing source text via safe direct fetch.         |
| `gemini_file_analyze`| Validate explicit local file paths for future Gemini ACP file/document analysis, then return unsupported until ACP file input is confirmed. |
| `gemini_code_review` | Analyze caller-provided code, diffs, or excerpts with Gemini ACP. Analysis-only; it does not read paths, edit files, or apply fixes.    |
| `gemini_translate`   | Translate/localize single text or ordered batches with glossary/preservation constraints through configured/authenticated Gemini ACP.   |
| `gemini_image_describe` | Validate explicit PNG/JPEG/WebP/GIF inputs and report unsupported Gemini ACP image capability until image transport is confirmed.     |
| `gemini_get_result`  | Retrieve stored full output by `responseId`.                                                                                            |

## Commands

| Command                 | Description                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/gemini-configure-acp` | Persist the local Gemini ACP command/args, defaulting to `gemini --acp`, and report whether the command is executable.                                                               |
| `/gemini-status`        | Show read-only command/auth/search-grounding/model/permission status with remediation and future ACP capability flags.                                                               |
| `/gemini-model`         | Show selectable Gemini model choices, accept aliases such as `pro` or `flash`, and persist a preferred model after confirming the configured ACP command advertises model selection. |
| `/gemini-permissions`   | Persist the restrictive/default ACP permission policy or explicitly confirm broader capabilities when needed.                                                                        |

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

That means `gemini_search` and `gemini_research` work out of the box when `gemini --acp` is installed, authenticated, and search-capable. Override the command with environment variables when needed:

```bash
export PI_GEMINI_ACP_COMMAND=gemini
export PI_GEMINI_ACP_ARGS="--acp"
```

Runtime config is stored under `~/.pi/gemini-acp/` when persisted by commands such as `/gemini-configure-acp`, `/gemini-model`, and `/gemini-permissions`. Use `/gemini-status` any time to inspect the resulting read-only command/auth/capability preflight state, including file-analysis and unconfirmed image-input transport status. Tool calls may also provide local documents/sources for no-key search/research operation; prompt/extract/summarize/code-review/translation workflows require configured/authenticated Gemini ACP and do not provide local/no-key fallback. `gemini_file_analyze` does not read file contents yet; it rejects directories, hidden paths, symlinks, and secret-like file names by default before reporting unsupported ACP file transport. `gemini_image_describe` validates only explicit image input paths or base64 data and returns a structured unsupported-capability error instead of sending image bytes to ACP.

Configure the local ACP command without editing JSON manually:

```bash
/gemini-configure-acp
/gemini-configure-acp gemini --acp
/gemini-configure-acp /opt/homebrew/bin/gemini --acp --model gemini-2.5-flash
```

Do not pass API keys or tokens to `/gemini-configure-acp`; use the Gemini CLI's local authentication flow instead.

Check status and remediation without changing settings:

```bash
/gemini-status
```

### Selecting a model

Run `/gemini-model` with no argument to see selectable choices. The command also exposes slash-command argument completions for common Gemini models.

```bash
/gemini-model
/gemini-model pro
/gemini-model flash
/gemini-model gemini-3.1-pro-preview
```

Known aliases include `pro`, `flash`, `flash-lite`, and `lite`, which resolve to the latest curated Gemini 3 preview choices. Versioned aliases such as `2.5-pro` remain available for compatibility. Full Gemini model ids such as `models/gemini-3-flash-preview` are still accepted.

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
