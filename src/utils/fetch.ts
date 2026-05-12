import { assertPublicHttpUrl } from "./assert.ts";
import { sha256Hex } from "./hash.ts";

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

const MAX_REDIRECT_HOPS = 5;

/** Standalone safe HTTP(S) fetcher used when no optional scraper integration is installed. */
export class DirectFetcher implements Fetcher {
	async fetch(url: string, opts: FetchOptions = {}): Promise<FetchedSource> {
		let currentUrl = assertPublicHttpUrl(url).toString();
		let hops = 0;

		while (hops < MAX_REDIRECT_HOPS) {
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

			const text = await readResponseText(response, opts.maxBytes);
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
			reader.releaseLock();
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

	return decoder.decode(merged);
}

export const directFetcher = new DirectFetcher();
