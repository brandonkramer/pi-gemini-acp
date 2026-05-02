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
- A locally installed/authenticated Gemini ACP command for real Gemini-backed search. By default, the extension runs `gemini --acp`.

## Tools

| Tool                | Description                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `gemini_search`     | Run structured search through configured Gemini ACP, or local documents when supplied.                                          |
| `gemini_research`   | Run Gemini ACP-backed research with source/citation tracking. Can optionally hydrate missing source text via safe direct fetch. |
| `gemini_get_result` | Retrieve stored full output by `responseId`.                                                                                    |

## Commands

| Command                         | Description                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/gemini-login-help`            | Read-only local Gemini ACP login/auth remediation. It does not run auth flows or print credentials.                                                                                  |
| `/gemini-set-model`             | Show selectable Gemini model choices, accept aliases such as `pro` or `flash`, and persist a preferred model after confirming the configured ACP command advertises model selection. |
| `/gemini-set-permission-policy` | Persist the restrictive/default ACP permission policy or explicitly confirm broader capabilities when needed.                                                                        |

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

Runtime config is stored under `~/.pi/gemini-acp/` when persisted by commands such as `/gemini-set-model` and `/gemini-set-permission-policy`. Tool calls may also provide local documents/sources for no-key operation.

### Selecting a model

Run `/gemini-set-model` with no argument to see selectable choices. The command also exposes slash-command argument completions for common Gemini models.

```bash
/gemini-set-model
/gemini-set-model pro
/gemini-set-model flash
/gemini-set-model gemini-3.1-pro-preview
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
