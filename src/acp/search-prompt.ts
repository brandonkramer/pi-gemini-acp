import type { GeminiAcpSearchRequest } from "./client.ts";

/** Builds the prompt sent to Gemini ACP for grounded web search. */
export function searchPrompt(request: GeminiAcpSearchRequest): string {
	return `Be concise. Search web: ${request.query}\nReturn JSON array only, max ${request.maxResults}. No prose or markdown. Emit as soon as results are available and stop after the closing ]. Format: [{"title":string,"url":string,"snippet":string}]`;
}
