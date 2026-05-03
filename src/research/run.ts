import { runSearch, type SearchDeps } from "../search/run.js";
import { storeResult } from "../storage/results.js";
import type {
	ResearchCitation,
	ResearchFinding,
	ResearchResult,
	ResearchSource,
	SearchResultItem,
	StructuredError,
} from "../types.js";
import { normalizeUrl } from "../url/normalize.js";
import {
	hasResearchProviderMetadata,
	type InsertedProviderCitation,
	insertProviderCitationMarkers,
	type NormalizedResearchProviderMetadata,
	normalizeResearchProviderMetadata,
} from "./citations.js";
import {
	FetchSourceHydrator,
	hydrateError,
	type PiScraperPresence,
	type SourceHydrator,
} from "./hydrate.js";

export type ResearchProgressPhase =
	| "search"
	| "hydrate"
	| "assemble"
	| "store"
	| "done";

export interface ResearchProgressUpdate {
	phase: ResearchProgressPhase;
	message: string;
	completedSources?: number;
	totalSources?: number;
	responseId?: string;
}

export type ResearchProgressReporter = (
	update: ResearchProgressUpdate,
) => void | Promise<void>;

/** Options for the Gemini research workflow. */
export interface ResearchOptions {
	query: string;
	maxResults?: number;
	sources?: Array<{
		title?: string;
		url: string;
		text?: string;
		snippet?: string;
		providerMetadata?: unknown;
	}>;
	hydrateSources?: boolean;
	hydrationMode?: "none" | "fetch";
	rootDir?: string;
}

/** Dependencies for research orchestration and test seams. */
export interface ResearchDeps extends Omit<SearchDeps, "onProgress"> {
	hydrator?: SourceHydrator;
	piScraper?: PiScraperPresence;
	onProgress?: ResearchProgressReporter;
}

/** Runs research, preserves local/no-key source mode, and stores the full result. */
export async function runResearch(
	options: ResearchOptions,
	deps: ResearchDeps = {},
	signal?: AbortSignal,
): Promise<ResearchResult> {
	await emitProgress(deps.onProgress, {
		phase: "search",
		message: options.sources?.length
			? "Using supplied sources."
			: "Searching with configured Gemini ACP provider.",
		totalSources: options.sources?.length ?? options.maxResults,
	});
	const sources = options.sources?.length
		? sourcesFromInput(options.sources)
		: await sourcesFromSearch(options, deps, signal);
	await emitProgress(deps.onProgress, {
		phase: "search",
		message: `Collected ${sources.length} source(s).`,
		completedSources: sources.length,
		totalSources: sources.length,
	});

	await emitProgress(deps.onProgress, {
		phase: "hydrate",
		message: options.hydrateSources
			? "Hydrating missing source text."
			: "Source hydration skipped.",
		completedSources: 0,
		totalSources: sources.length,
	});
	const hydrated = options.hydrateSources
		? await hydrateMissingSources(
				sources,
				deps.hydrator ?? new FetchSourceHydrator(),
				signal,
				deps.onProgress,
			)
		: sources;

	await emitProgress(deps.onProgress, {
		phase: "assemble",
		message: "Assembling findings and citations.",
		completedSources: hydrated.length,
		totalSources: hydrated.length,
	});
	const assembled = assembleFindingsAndCitations(hydrated);
	const result: ResearchResult = {
		query: options.query,
		summary:
			assembled.findings.length > 0
				? `Research for '${options.query}' collected ${hydrated.length} source(s).`
				: `Research for '${options.query}' found no source text.`,
		mode: options.sources?.length ? "local" : "gemini-acp",
		sources: hydrated,
		findings: assembled.findings,
		citations: assembled.citations,
	};

	await emitProgress(deps.onProgress, {
		phase: "store",
		message: "Storing full research result.",
	});
	const stored = await storeResult(result, { rootDir: options.rootDir });
	const finalResult = {
		...result,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
	await emitProgress(deps.onProgress, {
		phase: "done",
		message: "Research complete.",
		completedSources: hydrated.length,
		totalSources: hydrated.length,
		responseId: stored.responseId,
	});
	return finalResult;
}

async function sourcesFromSearch(
	options: ResearchOptions,
	deps: ResearchDeps,
	signal?: AbortSignal,
): Promise<ResearchSource[]> {
	const result = await runSearch(
		{
			query: options.query,
			maxResults: options.maxResults,
			rootDir: options.rootDir,
		},
		{
			geminiAcpClient: deps.geminiAcpClient,
			geminiAcpClientFactory: deps.geminiAcpClientFactory,
			commandExists: deps.commandExists,
			authProbe: deps.authProbe,
		},
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
		providerMetadata: normalizedMetadataOrUndefined(source.providerMetadata),
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
		providerMetadata: normalizedMetadataOrUndefined(result.source.raw),
	};
}

async function hydrateMissingSources(
	sources: ResearchSource[],
	hydrator: SourceHydrator,
	signal?: AbortSignal,
	onProgress?: ResearchProgressReporter,
): Promise<ResearchSource[]> {
	const hydrated: ResearchSource[] = [];
	for (const source of sources) {
		if (source.text?.trim()) {
			hydrated.push(source);
			await emitProgress(
				onProgress,
				hydrationProgress(hydrated.length, sources),
			);
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
		await emitProgress(onProgress, hydrationProgress(hydrated.length, sources));
	}
	return hydrated;
}

function assembleFindingsAndCitations(sources: ResearchSource[]): {
	findings: ResearchFinding[];
	citations: ResearchCitation[];
} {
	const findings: ResearchFinding[] = [];
	const citations: ResearchCitation[] = [];
	for (const source of sources) {
		const baseText = source.text ?? source.snippet;
		const findingText = baseText?.slice(0, 500);
		const metadata = metadataFromSource(source);
		const inserted = findingText
			? metadata
				? insertProviderCitationMarkers(findingText, metadata)
				: { text: findingText, citations: [] }
			: undefined;
		if (inserted?.text)
			findings.push({ sourceId: source.id, text: inserted.text });
		citations.push(
			...providerCitations(source, inserted?.citations ?? []),
			baseCitation(source),
		);
	}
	return { findings, citations };
}

function providerCitations(
	source: ResearchSource,
	inserted: InsertedProviderCitation[],
): ResearchCitation[] {
	return inserted.map((citation) => ({
		sourceId: source.id,
		url:
			citation.providerSources.find((providerSource) => providerSource.url)
				?.url ?? source.normalizedUrl,
		text: citation.text,
		marker: citation.marker,
		startByte: citation.startByte,
		endByte: citation.endByte,
		providerSources: citation.providerSources,
	}));
}

function baseCitation(source: ResearchSource): ResearchCitation {
	return {
		sourceId: source.id,
		url: source.normalizedUrl,
		text: source.snippet,
	};
}

function metadataFromSource(
	source: ResearchSource,
): NormalizedResearchProviderMetadata | undefined {
	return source.providerMetadata as
		| NormalizedResearchProviderMetadata
		| undefined;
}

function normalizedMetadataOrUndefined(
	raw: unknown,
): NormalizedResearchProviderMetadata | undefined {
	if (raw === undefined) return undefined;
	const metadata = normalizeResearchProviderMetadata(raw);
	return hasResearchProviderMetadata(metadata) ? metadata : undefined;
}

function hydrationProgress(
	completed: number,
	sources: ResearchSource[],
): ResearchProgressUpdate {
	return {
		phase: "hydrate",
		message: `Hydrated ${completed}/${sources.length} source(s).`,
		completedSources: completed,
		totalSources: sources.length,
	};
}

async function emitProgress(
	onProgress: ResearchProgressReporter | undefined,
	update: ResearchProgressUpdate,
): Promise<void> {
	try {
		await onProgress?.(update);
	} catch {
		/* progress delivery must not fail the final research result */
	}
}

function hydrationFailureText(error: StructuredError): string {
	return `[${error.code}] ${error.message}`;
}
