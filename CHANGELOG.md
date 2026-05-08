# Changelog

All notable changes to `pi-gemini-acp` are documented here.

This changelog is maintained from git history and follows a Keep-a-Changelog-style format.

## [Unreleased]

### Added

- Added persistent Gemini tool response caching backed by SQLite, with cache markers, retention, atomic result writes, and `/gemini-config cache` controls (`81db6da`).
- Added semantic-recall infrastructure: `sqlite-vec`, embedding queue/schema, recall text generation, recall enable/disable status, and an honest unavailable production embedder seam (`e6f96a2`).
- Added the public `gemini_recall` tool plus opt-in `useRecall` / `bypassRecall` support for `gemini_search` and `gemini_research` (`3d19496`).

### Changed

- Shared provider-result handling across prompt/search/tool/config paths (`c6d7c9d`, `d332f9d`).
- Shared JSON-RPC-over-stdio transport between ACP sessions and benchmark tooling (`adc0d98`).

### Notes

- `gemini_recall` is capability-gated: it returns an unavailable provider/capability error until a real embedding provider is configured and preflighted.

## [0.8.0] - 2026-05-04

### Added

- Added real `gemini_image_describe` support for explicit local image paths through validated ACP image `resource_link` parts (`21f9af6`).
- Added documentation for image-description requirements and Gemini ACP configuration (`6c693c5`, `a68ab4d`, `e5755b9`).

### Notes

- Base64 image provider transport remains unsupported; local image paths require filesystem-read permission and confirmed image/resource-link capabilities.

## [0.7.1] - 2026-05-04

### Fixed

- Made ACP tool cancellation behavior consistent across Gemini-backed tools (`787176a`).

### Performance

- Cached Gemini ACP search preflight checks and extended warm-client idle TTL (`cd42b7e`).
- Reused neutral-cwd cached Gemini search sessions (`4ecc1da`).
- Prewarmed Gemini ACP search on activation (`3a3e836`).
- Cancelled Gemini ACP search after streamed JSON is detected (`85d9dec`).
- Shortened the Gemini ACP search prompt (`f9101a1`).

### Tests

- Added Windows command-shim quoting regression coverage (`927926e`).
- Excluded local Pi worktrees from Vitest runs (`1479aaf`).

## [0.7.0] - 2026-05-04

### Added

- Added validated `gemini_file_analyze` support using ACP file/document `resource_link` transport (`dde3532`).

### Fixed

- Resolved Windows Gemini command shim handling (`7c51047`).
- Improved `gemini_research` assistant output (`79dd4fe`).
- Exposed Gemini request arguments in progress output (`2c01943`).
- Showed extracted JSON directly in `gemini_extract` output (`0d34434`).

## [0.6.0] - 2026-05-03

### Added

- Added consistent Gemini tool rendering UX across Gemini tools (`a51c503`).

### Changed

- Extracted shared Gemini rendering primitives (`3bed45b`).
- Improved Gemini search tool UX (`7521ede`).

## [0.5.2] - 2026-05-03

### Changed

- Avoided unnecessary Gemini workspace trust checks (`e030c36`).

## [0.5.1] - 2026-05-03

### Changed

- Confirmed Gemini authentication during preflight (`34b4b2d`).

### Docs

- Refined README requirements, configuration guidance, and project summary (`c3ae66c`, `12dd07b`, `3d72c5e`).

### CI

- Skipped CI for markdown-only changes (`a855e80`).

## [0.5.0] - 2026-05-03

### Added

- Added warm Gemini prompt/search sessions and benchmark coverage (`a678e5b`, `f066b40`, `42ce4b7`, `7a8f497`).
- Added interactive pickers for `/gemini-config` and `/gemini-model` (`8a789e6`, `2d5cf53`, `d0581d7`).

### Changed

- Combined older Gemini config/status commands into `/gemini-config` (`8e9dc97`).
- Renamed `/gemini-config persist` to `/gemini-config command` (`d32c2d0`).
- Reworked permission toggles into `/gemini-config permissions` (`a536835`).
- Improved status evaluation by merging defaults before reporting status (`9bf63b4`).

### Docs

- Tightened configuration and command documentation (`520f2c6`, `32c00ec`, `5fb2e4a`).

## [0.4.0] - 2026-05-02

### Added

- Added capability-gated file and image tool surfaces (`1cf0f72`).
- Added Gemini status command support (`21895cc`).
- Added prompt-based Gemini tools for prompt, extraction, summarization, code review, and translation workflows (`cd1bbe1`, `5692a90`).

### Changed

- Renamed tool modules from `gemini-acp-*` to stable `gemini-*` names (`d32a02e`).
- Renamed command surface toward the stable `/gemini-*` command names (`55ab91d`, `2aaad57`).
- Added Gemini 3 preview model choices to curated model aliases (`b0528bb`).

## [0.3.0] - 2026-05-02

### Added

- Added default `gemini --acp` provider configuration and model selection aliases (`933b76d`).

## [0.2.1] - 2026-05-02

### Fixed

- Fixed command registration compatibility with Pi's two-argument `registerCommand` host API (`4d1490c`).

## [0.2.0] - 2026-05-02

### Fixed

- Added repository metadata required for Sigstore provenance validation (`bd7927d`).

## [0.1.0] - 2026-05-02

### Added

- Initial `pi-gemini-acp` package seed (`182a9d1`).
- Added CI/publish workflows, lint/audit tooling, and packaged Gemini skill setup (`5bb606b`).
- Added early Gemini model/login/permission commands (`e181cf3`).

[Unreleased]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/brandonkramer/pi-gemini-acp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/brandonkramer/pi-gemini-acp/releases/tag/v0.1.0
