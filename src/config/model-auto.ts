/** @file The Gemini CLI routing model ("auto") under its Pi id and accepted spellings. */

/** Pi model id for Gemini CLI's dynamic routing model. */
export const GEMINI_AUTO_MODEL_ID = "gemini-auto";

const AUTO_PATTERN = /^(?:models\/)?(?:gemini-)?auto$/iu;

/** Matches `auto`, `gemini-auto`, with or without the `models/` prefix, case-insensitively. */
export function isGeminiAutoModel(model: string): boolean {
	return AUTO_PATTERN.test(model.trim());
}
