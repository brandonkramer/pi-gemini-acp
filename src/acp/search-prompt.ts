import type { GeminiAcpSearchRequest } from "./client.js";

/** Builds the prompt sent to Gemini ACP for grounded web search. */
export function searchPrompt(request: GeminiAcpSearchRequest): string {
	return `Search web: ${request.query}\nReturn JSON array only, max ${request.maxResults}: [{"title":string,"url":string,"snippet":string}]`;
}
