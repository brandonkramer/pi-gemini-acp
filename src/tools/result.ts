import type { PiToolShell, ResultEnvelope, StructuredError } from "../types.js";

/** Builds the standard Pi tool success shell with human text and structured details. */
export function toolResult<TData>(options: {
	text: string;
	data: TData;
	responseId?: string;
	fullOutputPath?: string;
	status?: number | string;
	title?: string;
}): PiToolShell<ResultEnvelope<TData>> {
	return {
		content: [{ type: "text", text: options.text }],
		details: {
			status: options.status ?? "ok",
			timing: { startedAt: new Date().toISOString() },
			responseId: options.responseId,
			fullOutputPath: options.fullOutputPath,
			data: options.data,
		},
		title: options.title,
	};
}

/** Builds the standard Pi tool error shell while preserving structured provider errors. */
export function errorResult<TData = null>(
	error: StructuredError,
	text = error.message,
	options: { responseId?: string; fullOutputPath?: string; data?: TData } = {},
): PiToolShell<ResultEnvelope<TData | null>> {
	return {
		content: [{ type: "text", text }],
		details: {
			status: "error",
			timing: { startedAt: new Date().toISOString() },
			responseId: options.responseId,
			fullOutputPath: options.fullOutputPath,
			error,
			data: options.data ?? null,
		},
	};
}
