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

That means `gemini_search` and `gemini_research` work out of the box when `gemini --acp` is installed, authenticated, and search-capable. Provider-backed `gemini_search`, `gemini_prompt`, and research source collection reuse short-lived warm ACP subprocesses with the same command, args, and capability policy, then close them after a brief idle period to reduce cold-start overhead without keeping Gemini ACP alive forever. `gemini_prompt` opens a fresh ACP session for each prompt so prompts do not become an implicit chat thread. Override the command with environment variables when needed:

```bash
export PI_GEMINI_ACP_COMMAND=gemini
export PI_GEMINI_ACP_ARGS="--acp"
```

Runtime config is stored under `~/.pi/gemini-acp/` when persisted by commands such as `/gemini-config command`, `/gemini-config permissions`, and `/gemini-model`. Use `/gemini-config status` any time to inspect the resulting read-only command/auth/capability preflight state, including file-analysis and unconfirmed image-input transport status. Tool calls may also provide local documents/sources for no-key search/research operation; prompt/extract/summarize/code-review/translation workflows require configured/authenticated Gemini ACP and do not provide local/no-key fallback. `gemini_file_analyze` does not read file contents yet; it rejects directories, hidden paths, symlinks, and secret-like file names by default before reporting unsupported ACP file transport. `gemini_image_describe` validates only explicit image input paths or base64 data and returns a structured unsupported-capability error instead of sending image bytes to ACP.

Inspect status or configure the local ACP command without editing JSON manually. Run `/gemini-config` with no arguments in interactive Pi to choose `status`, `command`, or `permissions` from Pi's picker UI. Choosing `command` or running `/gemini-config command` without command arguments opens a settings picker where you can stage command and arg edits separately, then explicitly save or cancel.

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

Do not pass API keys or tokens to `/gemini-config command`; use the Gemini CLI's local authentication flow instead. `status` is read-only; `command` validates command/args, saves to `~/.pi/gemini-acp/config/settings.json`, and reports whether the command is executable. Use `/gemini-config permissions` to display capability toggles for filesystem read, filesystem write, and terminal execution; enabling filesystem write or terminal execution requires `confirmRisk=true` because those capabilities allow the ACP to modify files or run shell commands.

### Selecting a model

Run `/gemini-model` with no argument in interactive Pi to choose from Pi's picker UI; headless sessions print selectable choices. The command also exposes slash-command argument completions for common Gemini models.

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
