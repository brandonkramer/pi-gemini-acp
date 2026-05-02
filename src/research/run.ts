import { runSearch, type SearchDeps } from "../search/run.js";
import { storeResult } from "../storage/results.js";
import type {
	ResearchResult,
	ResearchSource,
	SearchResultItem,
	StructuredError,
} from "../types.js";
import { normalizeUrl } from "../url/normalize.js";
import {
	FetchSourceHydrator,
	hydrateError,
	type PiScraperPresence,
	type SourceHydrator,
} from "./hydrate.js";

export interface ResearchOptions {
	query: string;
	maxResults?: number;
	sources?: Array<{
		title?: string;
		url: string;
		text?: string;
		snippet?: string;
	}>;
	hydrateSources?: boolean;
	hydrationMode?: "none" | "fetch";
	rootDir?: string;
}

export interface ResearchDeps extends SearchDeps {
	hydrator?: SourceHydrator;
	piScraper?: PiScraperPresence;
}

export async function runResearch(
	options: ResearchOptions,
	deps: ResearchDeps = {},
	signal?: AbortSignal,
): Promise<ResearchResult> {
	const sources = options.sources?.length
		? sourcesFromInput(options.sources)
		: await sourcesFromSearch(options, deps, signal);
	const hydrated = options.hydrateSources
		? await hydrateMissingSources(
				sources,
				deps.hydrator ?? new FetchSourceHydrator(),
				signal,
			)
		: sources;
	const findings = hydrated.flatMap((source) =>
		source.text || source.snippet
			? [
					{
						sourceId: source.id,
						text: (source.text ?? source.snippet ?? "").slice(0, 500),
					},
				]
			: [],
	);
	const result: ResearchResult = {
		query: options.query,
		summary:
			findings.length > 0
				? `Research for '${options.query}' collected ${hydrated.length} source(s).`
				: `Research for '${options.query}' found no source text.`,
		mode: options.sources?.length ? "local" : "gemini-acp",
		sources: hydrated,
		findings,
		citations: hydrated.map((source) => ({
			sourceId: source.id,
			url: source.normalizedUrl,
			text: source.snippet,
		})),
	};
	const stored = await storeResult(result, { rootDir: options.rootDir });
	return { ...result, responseId: stored.responseId };
}

async function sourcesFromSearch(
	options: ResearchOptions,
	deps: SearchDeps,
	signal?: AbortSignal,
): Promise<ResearchSource[]> {
	const result = await runSearch(
		{
			query: options.query,
			maxResults: options.maxResults,
			rootDir: options.rootDir,
		},
		deps,
		signal,
	);
	if (result.error) return [];
	return result.results.map(sourceFromSearchResult);
}

function sourcesFromInput(
	input: NonNullable<ResearchOptions["sources"]>,
): ResearchSource[] {
	return input.map((source, index) => ({
		id: `s${index + 1}`,
		title: source.title,
		url: source.url,
		normalizedUrl: normalizeUrl(source.url),
		text: source.text,
		snippet: source.snippet,
	}));
}

function sourceFromSearchResult(
	result: SearchResultItem,
	index: number,
): ResearchSource {
	return {
		id: `s${index + 1}`,
		title: result.title,
		url: result.url,
		normalizedUrl: result.normalizedUrl,
		snippet: result.snippet,
		provider: result.source.provider,
	};
}

async function hydrateMissingSources(
	sources: ResearchSource[],
	hydrator: SourceHydrator,
	signal?: AbortSignal,
): Promise<ResearchSource[]> {
	const hydrated: ResearchSource[] = [];
	for (const source of sources) {
		if (source.text?.trim()) {
			hydrated.push(source);
			continue;
		}
		try {
			hydrated.push(await hydrator.hydrate(source, signal));
		} catch (error) {
			hydrated.push({
				...source,
				text: hydrationFailureText(
					hydrateError(
						error instanceof Error ? error.message : "Source hydration failed",
					),
				),
			});
		}
	}
	return hydrated;
}

function hydrationFailureText(error: StructuredError): string {
	return `[${error.code}] ${error.message}`;
}
