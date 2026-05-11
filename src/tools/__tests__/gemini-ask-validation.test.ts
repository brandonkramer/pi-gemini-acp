/** @file Runtime validation coverage for the compact gemini_ask aggregate schema. */
import { describe, expect, it } from "vitest";

import type { ResultEnvelope } from "../../types.js";
import { geminiAskTool } from "../gemini-ask.js";

async function executeAsk(arguments_: unknown) {
	return await geminiAskTool.execute(
		"ask-validation-test",
		arguments_ as never,
		new AbortController().signal,
	);
}

describe("gemini_ask compact-schema runtime validation", () => {
	it("rejects invalid summarize enum and count values before delegation", async () => {
		const badStyle = await executeAsk({
			task: "summarize",
			content: "alpha",
			style: "verbose",
		});
		expect((badStyle.details as ResultEnvelope).status).toBe("error");
		expect((badStyle.details as ResultEnvelope).error?.code).toBe("GEMINI_ASK_INVALID_PARAMETER");

		const badCount = await executeAsk({
			task: "summarize",
			content: "alpha",
			bulletCount: 21,
		});
		expect((badCount.details as ResultEnvelope).status).toBe("error");
		expect((badCount.details as ResultEnvelope).error?.message).toContain("Allowed range: 1 to 20");
	});

	it("rejects invalid code review focus and severity before delegation", async () => {
		const badFocus = await executeAsk({
			task: "code_review",
			code: "const x = 1;",
			focus: ["correctness", "style"],
		});
		expect((badFocus.details as ResultEnvelope).status).toBe("error");
		expect((badFocus.details as ResultEnvelope).error?.message).toContain("Invalid focus");

		const badSeverity = await executeAsk({
			task: "code_review",
			code: "const x = 1;",
			severityThreshold: "optional",
		});
		expect((badSeverity.details as ResultEnvelope).status).toBe("error");
		expect((badSeverity.details as ResultEnvelope).error?.message).toContain(
			"Invalid severityThreshold",
		);
	});

	it("rejects malformed translate batch and glossary items before delegation", async () => {
		const badBatch = await executeAsk({
			task: "translate",
			targetLanguage: "Spanish",
			batch: [{ id: "a" }],
		});
		expect((badBatch.details as ResultEnvelope).status).toBe("error");
		expect((badBatch.details as ResultEnvelope).error?.message).toContain("batch item");

		const badGlossary = await executeAsk({
			task: "translate",
			targetLanguage: "Spanish",
			text: "hello",
			glossary: [{ source: "Pi" }],
		});
		expect((badGlossary.details as ResultEnvelope).status).toBe("error");
		expect((badGlossary.details as ResultEnvelope).error?.message).toContain("glossary entry");
	});
});
