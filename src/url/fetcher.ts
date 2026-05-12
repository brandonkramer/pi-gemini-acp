import { sha256Hex } from "../utils/hash.ts";
import { assertPublicHttpUrl } from "./public.ts";

export interface FetchedSource {
	url: string;
	text: string;
	contentType?: string;
	contentHash: string;
	fetchedAt: string;
	cached?: boolean;
	ageMs?: number;
	staleness?: "fresh" | "aging" | "stale" | "revalidated";
}

export interface FetchOptions {
	signal?: AbortSignal;
	maxBytes?: number;
	cacheTtlSeconds?: number;
}

export interface Fetcher {
	fetch(url: string, opts?: FetchOptions): Promise<FetchedSource>;
}

/**
 * Maximum number of redirects to follow. After this many 3xx responses, the next response MUST be
 * non-3xx or the fetch errors. Example: with MAX_REDIRECT_HOPS = 5, a chain of URL1 → URL2 → URL3 →
 * URL4 → URL5 → URL6 (200) succeeds and returns URL6's body.
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * Default byte cap for direct fetches. Applied by DirectFetcher.fetch when the caller does not pass
 * an explicit maxBytes. The value (4 MiB) is roughly 10× a "large" article body and covers HTML,
 * RSS, and JSON sources used by gemini_research hydration and web_summarize source loading. Larger
 * fetches should be done through pi-scraper, which has its own streaming + storage strategy.
 */
export const DEFAULT_FETCH_MAX_BYTES = 4 * 1024 * 1024;

/** Standalone safe HTTP(S) fetcher used when no optional scraper integration is installed. */
export class DirectFetcher implements Fetcher {
	async fetch(url: string, opts: FetchOptions = {}): Promise<FetchedSource> {
		let currentUrl = assertPublicHttpUrl(url).toString();
		let hops = 0;

		while (hops <= MAX_REDIRECT_HOPS) {
			const response = await fetch(currentUrl, {
				signal: opts.signal,
				redirect: "manual",
				headers: { accept: "text/plain,text/html,application/xhtml+xml" },
			});

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) {
					throw new Error(
						`Source fetch redirect failed: ${response.status} without Location header.`,
					);
				}
				currentUrl = new URL(location, currentUrl).toString();
				assertPublicHttpUrl(currentUrl);
				hops += 1;
				continue;
			}

			if (!response.ok) {
				throw new Error(`Source fetch failed with HTTP status ${response.status}.`);
			}

			const text = await readResponseText(response, opts.maxBytes ?? DEFAULT_FETCH_MAX_BYTES);
			return {
				url: currentUrl,
				text,
				contentType: response.headers.get("content-type") ?? undefined,
				contentHash: sha256Hex(text),
				fetchedAt: new Date().toISOString(),
			};
		}

		throw new Error(`Source fetch redirect exceeded ${MAX_REDIRECT_HOPS} hops.`);
	}
}

/**
 * Reads response body with an optional byte limit, aborting early when the budget is exceeded.
 * Falls back to response.text() when streaming is unavailable.
 */
async function readResponseText(response: Response, maxBytes?: number): Promise<string> {
	if (maxBytes === undefined || !response.body) {
		return await response.text();
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (totalBytes < maxBytes) {
		const { done, value } = await reader.read();
		if (done) break;

		if (totalBytes + value.length > maxBytes) {
			const remaining = maxBytes - totalBytes;
			chunks.push(value.subarray(0, remaining));
			totalBytes = maxBytes;
			// Cancel the body so the underlying download doesn't keep streaming after we have enough.
			// cancel() implicitly releases the lock.
			await reader.cancel();
			break;
		}

		chunks.push(value);
		totalBytes += value.length;
	}

	// Merge chunks into a single Uint8Array, then decode
	const merged = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}

	return decoder.decode(trimToUtf8Boundary(merged));
}

/**
 * Trims a Uint8Array to end on a complete UTF-8 codepoint boundary. When the byte cap lands
 * mid-codepoint, decoding the raw slice yields a U+FFFD replacement at the tail; trimming first
 * drops the incomplete trailing sequence so the decoded text ends on a real codepoint.
 */
function trimToUtf8Boundary(bytes: Uint8Array): Uint8Array {
	// UTF-8 codepoints span 1–4 bytes, so the last lead byte is at most 3 positions back.
	for (let back = 0; back < 4 && back < bytes.length; back += 1) {
		const idx = bytes.length - 1 - back;
		const byte = bytes[idx];
		// ASCII: complete on its own.
		if (byte < 0x80) return bytes;
		// Continuation byte (10xxxxxx): keep walking back to find the lead.
		if (byte < 0xc0) continue;
		// Lead byte (11xxxxxx). Expected total length: 2/3/4 based on leading bits.
		const expected = byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
		// `back` is the count of continuation bytes already seen after this lead.
		if (back + 1 === expected) return bytes;
		// Incomplete sequence — drop it.
		return bytes.subarray(0, idx);
	}
	return bytes;
}

export const directFetcher = new DirectFetcher();
