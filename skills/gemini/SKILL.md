---
name: gemini
description: Use Gemini ACP for grounded search/research, citations, source discovery, supplied-document recall or gemini prompt/extract/summarize/translate/code-review.
---

# Gemini

Use `pi-gemini-acp` for discovery and Gemini-backed/supplied-source synthesis. If `pi-scraper` is active, call scraper tools separately for page reading; this package does not invoke them directly.

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

1. Use `gemini_status` if ACP readiness matters.
2. Use `gemini_search` for URL discovery; use `gemini_research` for source/citation synthesis.
3. For fresh/current/latest/news requests, pass `bypassCache: true` and do not opt into recall unless the user asks to reuse prior work.
4. Prefer primary/high-authority sources. If scraper tools exist and exact claims matter, scrape top URLs before answering.
5. Cite URLs. Distinguish Gemini snippets/citations from scraper-verified page text.
6. Use `gemini_analyze` only for user-specified files/images; never imply directory scans or hidden/credential-file access.
7. Use `gemini_results(action: "recall")` as honest local FTS recall; zero hits are normal.

## Scrape after Gemini when

- exact quotes, dates, numbers, or claims matter;
- snippets are thin/conflicting;
- the URL is likely canonical docs, paper, changelog, release note, policy, or source page;
- the user asks to verify/audit/compare/extract.

Skip scraping for quick link lists, one supplied-text summary (`gemini_ask`), inaccessible/private pages, or when snippets are enough.

## Guardrails

- Do not claim hidden extension-to-extension execution; scraper calls are visible agent actions.
- Respect scraper URL safety and site access controls; do not bypass auth, CAPTCHAs, or blocks.
- Cache: exact cache may win unless `bypassCache: true`; recall is opt-in and visibly marked with similarity/age/responseId.
- Local/no-key mode works only over supplied docs/sources.
