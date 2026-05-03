import {
	runSearch,
	type SearchDeps,
	type SearchProgressUpdate,
	type SearchRunResult,
} from "../search/run.js";
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
	query?: string;
	mode?: "local" | "gemini-acp";
	maxResults?: number;
	hydrateSources?: boolean;
	hydrationMode?: "none" | "fetch";
	provider?: "local" | "gemini-acp";
	model?: string;
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

type ResearchProvider = "local" | "gemini-acp";

type CollectedResearchSources = {
	sources: ResearchSource[];
	provider?: ResearchProvider;
	model?: string;
};

/** Runs research, preserves local/no-key source mode, and stores the full result. */
export async function runResearch(
	options: ResearchOptions,
	deps: ResearchDeps = {},
	signal?: AbortSignal,
): Promise<ResearchResult> {
	const request = researchRequest(options);
	if (options.sources?.length) {
		await emitProgress(deps.onProgress, {
			phase: "search",
			message: request.message,
			query: options.query,
			mode: request.mode,
			provider: request.provider,
			model: request.model,
			maxResults: request.maxResults,
			hydrateSources: request.hydrateSources,
			hydrationMode: request.hydrationMode,
			totalSources: options.sources.length,
		});
	}
	const collected = options.sources?.length
		? {
				sources: sourcesFromInput(options.sources),
				provider: request.provider,
				model: request.model,
			}
		: await sourcesFromSearch(options, deps, signal);
	const { sources, provider, model } = collected;
	await emitProgress(deps.onProgress, {
		phase: "search",
		message: `Collected ${sources.length} source(s).`,
		query: options.query,
		mode: request.mode,
		provider,
		model,
		completedSources: sources.length,
		totalSources: sources.length,
	});

	await emitProgress(deps.onProgress, {
		phase: "hydrate",
		message: options.hydrateSources
			? "Hydrating missing source text."
			: "Source hydration skipped.",
		query: options.query,
		mode: request.mode,
		provider,
		model,
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
		query: options.query,
		mode: request.mode,
		provider,
		model,
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
		provider,
		model,
		sources: hydrated,
		findings: assembled.findings,
		citations: assembled.citations,
	};

	await emitProgress(deps.onProgress, {
		phase: "store",
		message: "Storing full research result.",
		query: options.query,
		mode: request.mode,
		provider,
		model,
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
		query: options.query,
		mode: request.mode,
		provider,
		model,
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
): Promise<CollectedResearchSources> {
	const maxResults = options.maxResults ?? 5;
	const result = await runSearch(
		{
			query: options.query,
			maxResults,
			rootDir: options.rootDir,
		},
		{
			geminiAcpClient: deps.geminiAcpClient,
			geminiAcpClientFactory: deps.geminiAcpClientFactory,
			commandExists: deps.commandExists,
			authProbe: deps.authProbe,
			onProgress: (update) =>
				emitSearchCollectionProgress(
					update,
					options,
					maxResults,
					deps.onProgress,
				),
		},
		signal,
	);
	if (result.error) return emptySearchCollection(result);
	return {
		sources: result.results.map(sourceFromSearchResult),
		provider: result.provider,
		model: result.model,
	};
}

async function emitSearchCollectionProgress(
	update: SearchProgressUpdate,
	options: ResearchOptions,
	maxResults: number,
	onProgress?: ResearchProgressReporter,
): Promise<void> {
	if (update.phase === "provider_preflight") {
		await emitProgress(onProgress, {
			phase: "search",
			message: "Checking Gemini ACP command, auth, and search grounding.",
			query: options.query,
			mode: "gemini-acp",
			provider: update.provider,
			model: update.model,
			maxResults,
			hydrateSources: Boolean(options.hydrateSources),
			hydrationMode: options.hydrateSources ? "fetch" : "none",
		});
		return;
	}
	if (update.phase !== "provider_search") return;
	await emitProgress(onProgress, {
		phase: "search",
		message: `Searching research query: "${options.query}" with ${maxResults} max results via ${update.model ?? "Gemini ACP default"}.`,
		query: options.query,
		mode: "gemini-acp",
		provider: update.provider,
		model: update.model,
		maxResults,
		hydrateSources: Boolean(options.hydrateSources),
		hydrationMode: options.hydrateSources ? "fetch" : "none",
	});
}

function emptySearchCollection(
	result: SearchRunResult,
): CollectedResearchSources {
	return {
		sources: [],
		provider: result.provider,
		model: result.model,
	};
}

function researchRequest(options: ResearchOptions): {
	message: string;
	mode: ResearchProvider;
	provider: ResearchProvider;
	model?: string;
	maxResults?: number;
	hydrateSources: boolean;
	hydrationMode: "none" | "fetch";
} {
	const hydrateSources = Boolean(options.hydrateSources);
	const hydrationMode = hydrateSources ? "fetch" : "none";
	if (options.sources?.length) {
		return {
			message: `Using ${options.sources.length} supplied source(s) for research query: "${options.query}".`,
			mode: "local",
			provider: "local",
			hydrateSources,
			hydrationMode,
		};
	}
	const maxResults = options.maxResults ?? 5;
	return {
		message: `Searching research query: "${options.query}" with ${maxResults} max results.`,
		mode: "gemini-acp",
		provider: "gemini-acp",
		maxResults,
		hydrateSources,
		hydrationMode,
	};
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
