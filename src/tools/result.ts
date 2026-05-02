import type { PiToolShell, ResultEnvelope, StructuredError } from "../types.js";

export function toolResult<TData>(options: {
	text: string;
	data: TData;
	responseId?: string;
	fullOutputPath?: string;
	status?: number | string;
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
	};
}

export function errorResult(
	error: StructuredError,
	text = error.message,
): PiToolShell<ResultEnvelope<null>> {
	return {
		content: [{ type: "text", text }],
		details: {
			timing: { startedAt: new Date().toISOString() },
			error,
			data: null,
		},
	};
}

export function providerError(
	code: string,
	phase: string,
	message: string,
	provider = "gemini-acp",
	retryable = false,
): StructuredError {
	return { code, phase, message, provider, retryable };
}
