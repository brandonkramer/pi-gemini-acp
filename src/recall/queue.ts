import { loadConfig, recallEnabledFromConfig } from "../config/settings.js";
import { openResponseCacheDb } from "../storage/cache-db.js";
import type { StorageOptions } from "../storage/paths.js";
import { getStoredResult } from "../storage/results.js";
import { defaultEmbedder, type Embedder } from "./embedder.js";
import { buildRecallText } from "./recall-text.js";

/** Options for enqueueing one background embedding job. */
export interface EnqueueEmbeddingOptions extends StorageOptions {
	responseId: string;
	embedder?: Embedder;
}

/** Options for draining pending background embedding jobs. */
export interface DrainEmbeddingOptions extends StorageOptions {
	concurrency?: number;
	embedder?: Embedder;
	signal?: AbortSignal;
	now?: number;
}

interface StoredCacheValue {
	recallInputs?: unknown;
	shell?: {
		content?: Array<{ text?: string }>;
		details?: { data?: unknown };
	};
	result?: unknown;
}

let scheduled = false;

/** Enqueues a response for background embedding when recall and an embedder are enabled. */
export async function enqueueEmbeddingJob(options: EnqueueEmbeddingOptions): Promise<boolean> {
	if (!(await shouldRunRecall(options))) return false;
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	try {
		db.enqueueEmbedding(options.responseId);
		return true;
	} finally {
		db.close();
	}
}

/** Schedules a best-effort queue drain without blocking the caller's tool response. */
export function scheduleEmbeddingQueueDrain(options: DrainEmbeddingOptions = {}): void {
	if (scheduled) return;
	scheduled = true;
	const timer = setTimeout(() => {
		scheduled = false;
		void drainEmbeddingQueue(options).catch(() => undefined);
	}, 0);
	timer.unref?.();
}

/** Drains pending embedding jobs with bounded concurrency and retry bookkeeping. */
export async function drainEmbeddingQueue(options: DrainEmbeddingOptions = {}): Promise<number> {
	if (!(await shouldRunRecall(options))) return 0;
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 8));
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	let jobs;
	try {
		jobs = db.nextEmbeddingJobs(concurrency, options.now ?? Date.now());
	} finally {
		db.close();
	}
	let completed = 0;
	await Promise.all(
		jobs.map(async (job) => {
			if (options.signal?.aborted) return;
			if (await processEmbeddingJob(job.responseId, options)) completed += 1;
		}),
	);
	return completed;
}

async function processEmbeddingJob(
	responseId: string,
	options: DrainEmbeddingOptions,
): Promise<boolean> {
	const embedder = options.embedder ?? defaultEmbedder();
	try {
		const recall = await recallPayloadForResponse(responseId, options);
		if (!recall) return true;
		const embedding = await embedder.embed(recall.recallText, options.signal);
		const db = await openResponseCacheDb({ rootDir: options.rootDir });
		try {
			db.putEmbedding({
				responseId,
				tool: recall.tool,
				recallText: recall.recallText,
				model: embedding.model,
				embedding: embedding.embedding,
			});
			db.deleteEmbeddingJob(responseId);
			return true;
		} finally {
			db.close();
		}
	} catch (cause) {
		const db = await openResponseCacheDb({ rootDir: options.rootDir });
		try {
			db.markEmbeddingFailure(responseId, errorMessage(cause));
		} finally {
			db.close();
		}
		return false;
	}
}

async function recallPayloadForResponse(
	responseId: string,
	options: StorageOptions,
): Promise<{ tool: string; recallText: string } | undefined> {
	const db = await openResponseCacheDb({ rootDir: options.rootDir });
	let tool: string | undefined;
	try {
		const row = db.responseById(responseId);
		tool = row?.tool;
	} finally {
		db.close();
	}
	if (!tool) return undefined;
	const stored = await getStoredResult<StoredCacheValue>(responseId, options);
	const value = stored.value;
	return {
		tool,
		recallText: buildRecallText({
			tool,
			inputs: value.recallInputs,
			result: resultForRecall(value),
		}),
	};
}

async function shouldRunRecall(options: StorageOptions & { embedder?: Embedder }) {
	if (!recallEnabledFromConfig(await loadConfig(options))) return false;
	const status = await (options.embedder ?? defaultEmbedder()).status(options);
	return status.available;
}

function resultForRecall(value: StoredCacheValue): unknown {
	if (value.shell) {
		return {
			text: value.shell.content?.[0]?.text,
			data: value.shell.details?.data,
		};
	}
	return value.result ?? value;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
