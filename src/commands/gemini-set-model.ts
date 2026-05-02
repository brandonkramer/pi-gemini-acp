import { type Static, Type } from "@mariozechner/pi-ai";
import { type ModelSelectionDeps, setGeminiAcpModel } from "../config/model.js";
import { errorResult, toolResult } from "../tools/result.js";
import { defineGeminiCommand } from "./define.js";

export const geminiSetModelSchema = Type.Object({
	model: Type.String({
		description:
			"Gemini model id to persist, for example gemini-2.5-pro or models/gemini-2.5-flash.",
	}),
});

type Params = Static<typeof geminiSetModelSchema>;

export async function setGeminiModel(
	params: Params,
	deps: ModelSelectionDeps & { rootDir?: string } = {},
) {
	const result = await setGeminiAcpModel(
		{ model: params.model, rootDir: deps.rootDir },
		deps,
	);
	if (result.error) return errorResult(result.error);
	return toolResult({
		text: `${result.status.message} Gemini ACP tools will pass this model when the configured command supports --model.`,
		data: result,
	});
}

export const geminiSetModelCommand = defineGeminiCommand({
	name: "gemini-set-model",
	description:
		"Persist the preferred Gemini model after confirming the configured ACP command supports model selection.",
	parameters: geminiSetModelSchema,
	execute: (params) => setGeminiModel(params),
});
