---
name: gemini
description: Use Gemini ACP for source discovery/research, then use pi-scraper tools such as web_scrape or web_batch when available to read, verify, hydrate, or quote important source pages. Use when a user asks for grounded web research, cited answers, source verification, or deeper reading after Gemini finds URLs.
---

# Gemini

Use this skill to combine `pi-gemini-acp` source discovery with optional `pi-scraper` page reading when both extensions are installed.

## Tool Roles

- `gemini_status` — check read-only Gemini ACP command/auth/capability status after applying the same default `gemini --acp` settings used by provider search; `/gemini-config status` exposes the same preflight state, `/gemini-config command` stages command/arg settings in Pi UI before saving, and `/gemini-config permissions` shows or updates ACP filesystem/terminal capability toggles.
- `gemini_prompt` — send a general prompt to configured/authenticated Gemini ACP when search grounding is not needed; arbitrary prompts have no local/no-key fallback.
- `gemini_extract` — extract structured JSON from supplied content with configured/authenticated Gemini ACP and a supported JSON-schema-like shape.
- `gemini_summarize` — summarize one supplied content item or one safe public HTTP(S) URL; use it for single-page/source summaries, not research synthesis.
- `gemini_search` — find candidate URLs with Gemini ACP web/search grounding, or search supplied documents locally when provided; provider-backed calls use the persistent response cache unless `bypassCache` is true, and can opt in to recall with `useRecall: true`.
- `gemini_research` — run a Gemini ACP-backed research pass with source/citation tracking; `useRecall: true` may reuse a high-confidence recent prior result when recall is available.
- `gemini_file_analyze` — capability-gated file/document analysis; validates explicit local file paths, rejects directories/hidden/symlink/secret-like paths by default, requires ACP filesystem-read permission, and sends only allowlisted files as resource links.
- `gemini_code_review` — analyze caller-provided code, diffs, or excerpts with Gemini ACP; analysis-only and does not read paths, edit files, or apply fixes.
- `gemini_translate` — translate/localize single text or ordered batches with glossary and preservation constraints; it requires configured/authenticated Gemini ACP and has no local/no-key fallback.
- `gemini_image_describe` — analyze explicit local PNG/JPEG/WebP/GIF image paths through Gemini ACP resource links when image and embedded-context capabilities are advertised; base64 inputs are validated but not sent.
- `gemini_recall` — query local semantic recall over prior Gemini results when embeddings and sqlite-vec are available; current production embedder is unavailable, so expect `GEMINI_ACP_RECALL_UNAVAILABLE` until a supported embedder is configured.
- `gemini_get_result` — retrieve full stored Gemini ACP outputs by `responseId`.
- `/gemini-config cache` — inspect or clear the persistent response cache; use `cache status` for counts plus embedding queue/model status, and `cache clear --tool gemini_search` for targeted cleanup.
- `/gemini-config recall` — enable, disable, or inspect semantic recall status; `PI_GEMINI_ACP_RECALL=0` disables tool registration plus embedding/recall work.
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
8. Use `gemini_file_analyze` only for explicit user-provided local files; set `cwd` when relative path resolution matters, and do not imply it can scan directories or inspect unlisted files.
9. Use `gemini_translate` only for user-requested translation/localization; provide target language, glossary, and preserve terms explicitly when needed.
10. Use `gemini_image_describe` only for explicit local image paths; set `cwd` when relative path resolution matters, and expect a structured unsupported-capability response if runtime ACP image/resource-link preflight fails.
11. Use `/gemini-config command` only when the local Gemini ACP command or args need to differ from the default `gemini --acp`; interactive Pi opens a settings picker and saves only after explicit confirmation.
12. Use `/gemini-config permissions` before advanced workflows that intentionally need ACP filesystem or terminal capabilities; enabling filesystem write or terminal execution requires explicit risk confirmation.
13. Use `bypassCache: true` when the user explicitly asks for a fresh Gemini call. Use `useCache: true` to opt in for `gemini_prompt` or `gemini_research`; other cacheable provider-backed tools cache successful responses by default.
14. Use `gemini_recall` only as an honest capability-gated local lookup. If it reports `GEMINI_ACP_RECALL_UNAVAILABLE`, run the live Gemini tool instead; do not pretend prior semantic recall exists.
15. Use `useRecall: true` on `gemini_search`/`gemini_research` only when the user is comfortable reusing very similar recent prior results. Exact cache hits still win first, and recall hits are visibly marked with similarity, age, and `responseId`.

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
