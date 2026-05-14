/** @file Opaque cursor and bounded paging helpers for stored-result views. */
import { Buffer } from "node:buffer";

import type { StructuredError } from "../types.ts";

export interface PageOptions {
	cursor?: string;
	limit?: number;
	defaultLimit: number;
	maxLimit: number;
}

export interface TextPage {
	text: string;
	start: number;
	end: number;
	nextCursor?: string;
	hasMore: boolean;
}

export interface ItemPage<T> {
	items: T[];
	start: number;
	end: number;
	nextCursor?: string;
	hasMore: boolean;
}

export type PageResult<T> = { ok: true; value: T } | { ok: false; error: StructuredError };

interface PageBounds {
	start: number;
	end: number;
	nextCursor?: string;
	hasMore: boolean;
}

export function pageText(value: string, options: PageOptions): PageResult<TextPage> {
	const bounds = pageBounds(value.length, options);
	if (!bounds.ok) return bounds;
	return {
		ok: true,
		value: { text: value.slice(bounds.value.start, bounds.value.end), ...bounds.value },
	};
}

export function pageItems<T>(items: T[], options: PageOptions): PageResult<ItemPage<T>> {
	const bounds = pageBounds(items.length, options);
	if (!bounds.ok) return bounds;
	return {
		ok: true,
		value: { items: items.slice(bounds.value.start, bounds.value.end), ...bounds.value },
	};
}

function pageBounds(totalLength: number, options: PageOptions): PageResult<PageBounds> {
	const offset = decodeCursor(options.cursor);
	if (!offset.ok) return offset;
	const limit = normalizedLimit(options.limit, options.defaultLimit, options.maxLimit);
	const start = Math.min(offset.value, totalLength);
	const end = Math.min(totalLength, start + limit);
	return {
		ok: true,
		value: {
			start,
			end,
			nextCursor: end < totalLength ? encodeCursor(end) : undefined,
			hasMore: end < totalLength,
		},
	};
}

function normalizedLimit(
	limit: number | undefined,
	defaultLimit: number,
	maxLimit: number,
): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return defaultLimit;
	return Math.min(Math.max(1, Math.trunc(limit)), maxLimit);
}

function decodeCursor(cursor: string | undefined): PageResult<number> {
	if (!cursor) return { ok: true, value: 0 };
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!isCursorPayload(decoded)) return invalidCursor();
		return { ok: true, value: decoded.offset };
	} catch {
		return invalidCursor();
	}
}

function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function isCursorPayload(value: unknown): value is { offset: number } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"offset" in value &&
		typeof value.offset === "number" &&
		Number.isInteger(value.offset) &&
		value.offset >= 0
	);
}

function invalidCursor(): PageResult<number> {
	return {
		ok: false,
		error: {
			code: "RESULT_CURSOR_INVALID",
			phase: "pagination",
			message: "Stored-result cursor is invalid or expired.",
			retryable: false,
		},
	};
}
