import type { GeminiAcpSearchRequest } from "./client.js";

/** Builds the prompt currently required because ACP has no stable search RPC. */
export function searchPrompt(request: GeminiAcpSearchRequest): string {
	return [
		`Run a grounded web search for: ${request.query}`,
		`Return up to ${request.maxResults} results as JSON only.`,
		'Use this exact shape: [{"title": string, "url": string, "snippet": string}]',
		"Do not include Markdown fences or explanatory text.",
	].join("\n");
}
