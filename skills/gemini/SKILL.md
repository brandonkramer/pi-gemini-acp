---
name: gemini
description: Use Gemini ACP for grounded search/research, citations, source discovery, supplied-document recall or gemini prompt/extract/summarize/translate/code-review.
---

# Gemini

Role: ACP-powered Gemini skill for grounded search/research, citations, source discovery, supplied-doc recall, and Gemini prompt/extract/summarize/translate/code-review.
Scope: Discovery + synthesis via `pi-gemini-acp`. Does NOT invoke scraper tools directly — call scraper separately when needed.
MUST NOT bypass auth/CAPTCHA/blocks, claim hidden extension-to-extension execution, or imply directory scans/credential-file access.
MUST reject unsafe paths in `gemini_analyze`; requires filesystem-read/resource-link capability. Base64 images are validation-only.
Local/no-key mode works only over supplied docs/sources.

## Tools

- `gemini_status` — ACP command/auth/capability preflight.
- `gemini_ask` — prompt/extract/summarize/translate/code-review supplied text; no path reads or edits.
- `gemini_search` — web grounding or supplied local-doc search. For latest/current/news/time-sensitive queries set `bypassCache: true`; recall reuse is opt-in with `useRecall: true`.
- `gemini_research` — source/citation research with optional safe fetch. Use `bypassCache: true` for latest/current/news topics; `useRecall: true` only when reuse is acceptable.
- `gemini_analyze` — explicit local file/image paths only; validates paths, rejects unsafe paths, requires filesystem-read/resource-link capability. Base64 images are validation-only.
- `gemini_results` — get stored output by `responseId` or run local SQLite FTS recall.
- `/gemini-config cache|recall|status|command|permissions|trust` — inspect/configure ACP, cache, recall, permissions, and Gemini CLI trust.
- Optional scraper: `web_scrape`/`web_batch` for reading URLs found by Gemini; `web_map`/`web_crawl` only for site-structure tasks.

## Workflow

- `gemini_status` if ACP readiness matters.
- `gemini_search` for URL discovery; `gemini_research` for source/citation synthesis.
- For fresh/current/latest/news requests MUST pass `bypassCache: true`; MUST NOT opt into recall unless user asks to reuse prior work.
- Prefer primary/high-authority sources. If scraper tools exist and exact claims matter, scrape top URLs before answering.
- Cite URLs. Distinguish Gemini snippets/citations from scraper-verified page text.
- `gemini_analyze` for user-specified files/images only; never imply directory scans or hidden/credential-file access.
- `gemini_results(action: "recall")` as honest local FTS recall; zero hits are normal.

## Scrape after Gemini when

- exact quotes, dates, numbers, or claims matter;
- snippets are thin/conflicting;
- the URL is likely canonical docs, paper, changelog, release note, policy, or source page;
- the user asks to verify/audit/compare/extract.

Skip scraping for quick link lists, one supplied-text summary (`gemini_ask`), inaccessible/private pages, or when snippets are enough.
