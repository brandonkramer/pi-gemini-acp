import type { ResearchSource, StructuredError } from "../types.js";

export interface SourceHydrator {
	hydrate(
		source: ResearchSource,
		signal?: AbortSignal,
	): Promise<ResearchSource>;
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
	async hydrate(
		source: ResearchSource,
		signal?: AbortSignal,
	): Promise<ResearchSource> {
		if (source.text?.trim()) return source;
		assertPublicHttpUrl(source.url);
		const response = await fetch(source.url, {
			signal,
			headers: { accept: "text/plain,text/html,application/xhtml+xml" },
		});
		const text = await response.text();
		return {
			...source,
			text: text
				.replace(/<script[\s\S]*?<\/script>/giu, " ")
				.replace(/<style[\s\S]*?<\/style>/giu, " ")
				.replace(/<[^>]+>/gu, " ")
				.replace(/\s+/gu, " ")
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

function assertPublicHttpUrl(input: string): void {
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Only HTTP(S) source hydration is supported");
	const host = url.hostname.toLowerCase();
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	)
		throw new Error("Private/local source hydration is blocked");
	if (
		/^(127|10|0)\./u.test(host) ||
		/^192\.168\./u.test(host) ||
		/^172\.(1[6-9]|2\d|3[0-1])\./u.test(host)
	)
		throw new Error("Private IPv4 source hydration is blocked");
	if (
		host === "::1" ||
		host.startsWith("fc") ||
		host.startsWith("fd") ||
		host.startsWith("fe80")
	)
		throw new Error("Private IPv6 source hydration is blocked");
}
