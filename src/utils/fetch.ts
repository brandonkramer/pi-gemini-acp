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

/** Standalone safe HTTP(S) fetcher used when no optional scraper integration is installed. */
export class DirectFetcher implements Fetcher {
	async fetch(url: string, opts: FetchOptions = {}): Promise<FetchedSource> {
		const safeUrl = assertPublicHttpUrl(url).toString();
		const response = await fetch(safeUrl, {
			signal: opts.signal,
			headers: { accept: "text/plain,text/html,application/xhtml+xml" },
		});
		if (!response.ok) {
			throw new Error(`Source fetch failed with HTTP status ${response.status}.`);
		}
		const text = (await response.text()).slice(0, opts.maxBytes);
		return {
			url: response.url || safeUrl,
			text,
			contentType: response.headers.get("content-type") ?? undefined,
			contentHash: sha256Hex(text),
			fetchedAt: new Date().toISOString(),
		};
	}
}

export const directFetcher = new DirectFetcher();
