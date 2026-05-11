import type { ResearchSource, StructuredError } from "../types.ts";
import { directFetcher, type Fetcher } from "../utils/fetch.ts";

export interface SourceHydrator {
	hydrate(source: ResearchSource, signal?: AbortSignal): Promise<ResearchSource>;
}

export interface PiScraperPresence {
	active: boolean;
	reason?: string;
}

export function detectPiScraper(pi: unknown): PiScraperPresence {
	try {
		const api = pi as {
			getActiveTools?: () => string[];
			getAllTools?: () => Array<{ name: string }>;
		};
		const activeTools = api.getActiveTools?.() ?? [];
		const allTools = api.getAllTools?.() ?? [];
		const names = new Set([...activeTools, ...allTools.map((t) => t.name)]);
		if (names.has("web_scrape")) return { active: true };
	} catch {
		/* Pi extension runtime not fully initialized yet; defer detection */
	}
	return {
		active: false,
		reason:
			"Pi does not expose an extension-to-extension tool discovery API during extension loading; pi-scraper presence will be confirmed after init.",
	};
}

export class FetchSourceHydrator implements SourceHydrator {
	constructor(private readonly fetcher: Fetcher = directFetcher) {}

	async hydrate(source: ResearchSource, signal?: AbortSignal): Promise<ResearchSource> {
		if (source.text?.trim()) return source;
		const fetched = await this.fetcher.fetch(source.url, { signal });
		return {
			...source,
			url: fetched.url,
			text: fetched.text
				.replaceAll(/<script[\s\S]*?<\/script>/giu, " ")
				.replaceAll(/<style[\s\S]*?<\/style>/giu, " ")
				.replaceAll(/<[^>]+>/gu, " ")
				.replaceAll(/\s+/gu, " ")
				.trim()
				.slice(0, 20_000),
			hydrated: true,
		};
	}
}

export function hydrateError(message: string): StructuredError {
	return {
		code: "SOURCE_HYDRATION_FAILED",
		phase: "hydrate",
		message,
		retryable: false,
	};
}
