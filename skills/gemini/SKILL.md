---
name: gemini
description: Use Gemini ACP for source discovery/research, then use pi-scraper tools such as web_scrape or web_batch when available to read, verify, hydrate, or quote important source pages. Use when a user asks for grounded web research, cited answers, source verification, or deeper reading after Gemini finds URLs.
---

# Gemini

Use this skill to combine `pi-gemini-acp` source discovery with optional `pi-scraper` page reading when both extensions are installed.

## Tool Roles

- `gemini_status` — check read-only Gemini ACP command/auth/capability status from explicit persisted/env settings before relying on provider-backed workflows; it is stricter than the legacy search default shim.
- `gemini_prompt` — send a general prompt to configured/authenticated Gemini ACP when search grounding is not needed; arbitrary prompts have no local/no-key fallback.
- `gemini_search` — find candidate URLs with Gemini ACP web/search grounding, or search supplied documents locally when provided.
- `gemini_research` — run a Gemini ACP-backed research pass with source/citation tracking.
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

## When to Scrape After Gemini ACP

Scrape source pages when:

- the answer needs exact quotes, dates, numbers, or claims;
- Gemini ACP snippets are thin or conflicting;
- a source is likely the canonical page, docs page, paper, changelog, release note, or policy page;
- the user asks to verify, audit, compare, or extract structured details from sources.

Skip scraping when:

- the user only wants a quick list of links;
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
- Prefer `web_scrape`/`web_batch` for reading pages and `gemini_search` for finding candidate pages.
- Use `web_research` from `pi-scraper` only when the user specifically wants pi-scraper's local/cache research mode; otherwise use `gemini_research` for Gemini ACP-backed research.
