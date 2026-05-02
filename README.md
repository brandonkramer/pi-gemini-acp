# pi-gemini-acp

Gemini ACP search and research provider for Pi.

`pi-gemini-acp` owns the optional Gemini ACP subprocess/runtime integration so other Pi extensions can stay local-first. It exposes standalone Gemini-backed search and research tools while keeping local/no-key search over supplied documents available for tests and offline workflows.

## Install

```bash
pi install npm:pi-gemini-acp
```

From a local checkout:

```bash
git clone <repo-url>
cd pi-gemini-acp
npm install
npm test
```

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.65.0`
- A locally installed/authenticated Gemini ACP command for real Gemini-backed search, commonly `gemini --acp`.

## Tools

| Tool                | Description                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `gemini_search`     | Run structured search through configured Gemini ACP, or local documents when supplied.                                          |
| `gemini_research`   | Run Gemini ACP-backed research with source/citation tracking. Can optionally hydrate missing source text via safe direct fetch. |
| `gemini_get_result` | Retrieve stored full output by `responseId`.                                                                                    |

## Commands

| Command                         | Description                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/gemini-login-help`            | Read-only local Gemini ACP login/auth remediation. It does not run auth flows or print credentials.           |
| `/gemini-set-model`             | Persist a preferred Gemini model after confirming the configured ACP command advertises model selection.      |
| `/gemini-set-permission-policy` | Persist the restrictive/default ACP permission policy or explicitly confirm broader capabilities when needed. |

## Configuration

For smoke tests and direct config, use environment variables:

```bash
export PI_GEMINI_ACP_COMMAND=gemini
export PI_GEMINI_ACP_ARGS="--acp"
```

Runtime config is stored under `~/.pi/gemini-acp/` when persisted by commands such as `/gemini-set-model` and `/gemini-set-permission-policy`. Tool calls may also provide local documents/sources for no-key operation.

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
