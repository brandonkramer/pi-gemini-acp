import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	GeminiAcpClient,
	GeminiAcpPromptRequest,
	GeminiAcpPromptUpdateHandler,
	GeminiAcpSearchRequest,
} from "../../acp/client.js";
import { getStoredResult } from "../../storage/results.js";
import type { SearchResultItem } from "../../types.js";
import { buildCodeReviewPrompt, runCodeReview } from "../code-review.js";
import { PROMPT_RESPONSE_INLINE_LIMIT } from "../run.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-review-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("buildCodeReviewPrompt", () => {
	it("requests deterministic analysis-only sections and focus", () => {
		const prompt = buildCodeReviewPrompt({
			diff: "diff --git a/a.ts b/a.ts",
			context: "Public API change.",
			focus: ["security", "tests"],
			severityThreshold: "important",
			maxFindings: 3,
		});

		expect(prompt).toContain("Do not edit files");
		expect(prompt).toContain("do not assume filesystem access");
		expect(prompt).toMatch(
			/## Blockers[\s\S]*## Important[\s\S]*## Optional[\s\S]*## Validation/,
		);
		expect(prompt).toContain("Focus areas: security, tests.");
		expect(prompt).toContain("Severity threshold: important.");
		expect(prompt).toContain("Maximum findings: 3.");
	});
});

describe("runCodeReview", () => {
	it("reviews supplied diff text through an injected Gemini ACP client", async () => {
		const review = [
			"## Blockers",
			"None found.",
			"## Important",
			"- [important] Missing test — diff changes behavior; add coverage.",
			"## Optional",
			"None found.",
			"## Validation",
			"- Run npm test.",
		].join("\n");
		const client = new FakeGeminiClient([review]);

		const result = await runCodeReview(
			{ diff: "@@ -1 +1 @@\n-old\n+new", rootDir, config: {} },
			{ commandExists: async () => true, geminiAcpClient: client },
		);

		expect(result.error).toBeUndefined();
		expect(result.text).toBe(review);
		expect(result.sections).toEqual([
			"Blockers",
			"Important",
			"Optional",
			"Validation",
		]);
		expect(client.promptText).toContain("@@ -1 +1 @@");
		expect(client.promptText).toContain("analysis-only code review");
	});

	it("rejects empty review input without contacting Gemini ACP", async () => {
		const client = new FakeGeminiClient(["unused"]);
		const result = await runCodeReview(
			{ rootDir, config: {} },
			{ commandExists: async () => true, geminiAcpClient: client },
		);

		expect(result.error?.code).toBe("GEMINI_CODE_REVIEW_EMPTY_INPUT");
		expect(client.promptText).toBe("");
	});

	it("preserves structured Gemini ACP preflight errors", async () => {
		const result = await runCodeReview(
			{
				code: "const value = 1;",
				rootDir,
				config: { providers: { "gemini-acp": { enabled: false } } },
			},
			{ commandExists: async () => true },
		);

		expect(result.error?.code).toBe("GEMINI_ACP_MISSING_CONFIG");
		expect(result.error?.phase).toBe("provider_preflight");
	});

	it("stores long review output behind a responseId", async () => {
		const fullText = `## Blockers\n${"x".repeat(PROMPT_RESPONSE_INLINE_LIMIT + 10)}`;
		const result = await runCodeReview(
			{ code: "const value = 1;", rootDir, config: {} },
			{
				commandExists: async () => true,
				geminiAcpClient: new FakeGeminiClient([fullText]),
			},
		);

		expect(result.truncated).toBe(true);
		expect(result.responseId).toBeTruthy();
		const stored = await getStoredResult<{ text: string }>(
			result.responseId ?? "",
			{ rootDir },
		);
		expect(stored.value.text).toBe(fullText);
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	promptText = "";

	constructor(private readonly chunks: string[]) {}

	async search(_request: GeminiAcpSearchRequest): Promise<SearchResultItem[]> {
		return [];
	}

	async prompt(
		request: GeminiAcpPromptRequest,
		_signal?: AbortSignal,
		onUpdate?: GeminiAcpPromptUpdateHandler,
	): Promise<string> {
		this.promptText = request.prompt;
		let accumulatedText = "";
		for (const text of this.chunks) {
			accumulatedText += text;
			await onUpdate?.({ type: "chunk", text, accumulatedText });
		}
		return accumulatedText;
	}
}
