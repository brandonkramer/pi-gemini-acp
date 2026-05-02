---
name: gemini
description: Use Gemini ACP for source discovery/research, then use pi-scraper tools such as web_scrape or web_batch when available to read, verify, hydrate, or quote important source pages. Use when a user asks for grounded web research, cited answers, source verification, or deeper reading after Gemini finds URLs.
---

# Gemini

Use this skill to combine `pi-gemini-acp` source discovery with optional `pi-scraper` page reading when both extensions are installed.

## Tool Roles

- `gemini_status` — check read-only Gemini ACP command/auth/capability status from explicit persisted/env settings before relying on provider-backed workflows; `/gemini-status` exposes the same preflight state for slash-command flows.
- `gemini_prompt` — send a general prompt to configured/authenticated Gemini ACP when search grounding is not needed; arbitrary prompts have no local/no-key fallback.
- `gemini_extract` — extract structured JSON from supplied content with configured/authenticated Gemini ACP and a supported JSON-schema-like shape.
- `gemini_summarize` — summarize one supplied content item or one safe public HTTP(S) URL; use it for single-page/source summaries, not research synthesis.
- `gemini_search` — find candidate URLs with Gemini ACP web/search grounding, or search supplied documents locally when provided.
- `gemini_research` — run a Gemini ACP-backed research pass with source/citation tracking.
- `gemini_file_analyze` — capability-gated file/document analysis seam; currently validates explicit local file paths, rejects directories/hidden/secret-like paths by default, and returns unsupported until ACP file input support is confirmed.
- `gemini_code_review` — analyze caller-provided code, diffs, or excerpts with Gemini ACP; analysis-only and does not read paths, edit files, or apply fixes.
- `gemini_translate` — translate/localize single text or ordered batches with glossary and preservation constraints; it requires configured/authenticated Gemini ACP and has no local/no-key fallback.
- `gemini_image_describe` — validate explicit PNG/JPEG/WebP/GIF image inputs and report unsupported Gemini ACP image capability until ACP image transport is confirmed; do not rely on it for actual caption/OCR/object extraction yet.
- `gemini_get_result` — retrieve full stored Gemini ACP outputs by `responseId`.
- `web_scrape` — if available, read one source page from `pi-scraper` for clean markdown/text.
- `web_batch` — if available, read several independent source pages from `pi-scraper`.
- `web_map` / `web_crawl` — if available, use only when the user asks for site structure or broader site coverage.

## Recommended Workflow

1. Start with `gemini_search` for URL discovery when the user needs current or broad web sources.
2. Prefer high-authority or primary-source URLs from the search results.
3. If `web_scrape` is available, scrape the most important pages before making detailed claims.
4. If multiple pages need reading and `web_batch` is available, use it instead of many individual scrape calls.
5. Use scraped markdown/text to verify facts, extract quotes, and resolve ambiguity.
6. Cite final answers with source URLs. Distinguish Gemini ACP-discovered snippets from content verified by scraper reads.
7. If `web_scrape`/`web_batch` are not available, continue with Gemini ACP citations/snippets and say that full-page verification was not available.
8. Use `gemini_file_analyze` only to check whether explicit file paths are acceptable for future file analysis; do not claim it reads or analyzes file contents until the tool reports supported ACP file/document transport.
9. Use `gemini_translate` only for user-requested translation/localization; provide target language, glossary, and preserve terms explicitly when needed.
10. Use `gemini_image_describe` only as a capability/status check for explicit image inputs until `/gemini-status` reports confirmed image input transport support.

## When to Scrape After Gemini ACP

Scrape source pages when:

- the answer needs exact quotes, dates, numbers, or claims;
- Gemini ACP snippets are thin or conflicting;
- a source is likely the canonical page, docs page, paper, changelog, release note, or policy page;
- the user asks to verify, audit, compare, or extract structured details from sources.

Skip scraping when:

- the user only wants a quick list of links;
- the user wants a summary of exactly one supplied text/page, where `gemini_summarize` is the better fit;
- Gemini ACP already returned enough source metadata for a lightweight answer;
- the source is inaccessible, private, or blocked and the user did not ask for browser/cloud escalation.

## Suggested Tool Sequence

For a normal research answer:

```text
gemini_search(query)
→ web_batch(urls: top 3–5 results, format: markdown, mode: auto) if available
→ answer with citations and note which sources were scraped
```

For deeper investigation:

```text
gemini_research(query)
→ gemini_get_result(responseId) if output was compact
→ web_scrape(url) for key sources needing verification
→ answer with source-by-source evidence
```

## Guardrails

- Do not claim that `pi-gemini-acp` directly invokes `web_scrape`; the agent orchestrates separate visible tool calls.
- Respect `pi-scraper` safety behavior: private-network URLs, unsupported schemes, and blocked pages may return structured errors.
- Do not bypass site access controls, CAPTCHAs, or authentication.
- Do not use `gemini_file_analyze` for hidden files, directories, symlinks, credential files, or broad workspace review; provide explicit user-controlled paths and instructions only.
- Prefer `web_scrape`/`web_batch` for reading pages and `gemini_search` for finding candidate pages.
- Use `web_research` from `pi-scraper` only when the user specifically wants pi-scraper's local/cache research mode; otherwise use `gemini_research` for Gemini ACP-backed research.
