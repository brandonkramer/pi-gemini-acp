/**
 * @file Keeps the history sent to a fresh Gemini session within a character budget. Long sessions
 *   (especially ones that used other models' tools) accumulate large tool results, and Gemini has
 *   to read all of them before it answers: one observed turn sent ~212k characters, ~194k of them
 *   tool output, for a one-line request.
 */

/** Default `chat.maxHistoryChars`: about 50k tokens of conversation. */
export const DEFAULT_MAX_HISTORY_CHARS = 200_000;

/** Older tool results are cut to this many characters before any message is dropped. */
const SHORTENED_TOOL_RESULT_CHARS = 2_000;

/** One flattened conversation message. */
export interface HistoryEntry {
	role: "user" | "assistant" | "toolResult";
	text: string;
}

/** Resolves `chat.maxHistoryChars`: undefined uses the default, 0 or less disables the budget. */
export function maxHistoryChars(setting: number | undefined): number {
	if (setting === undefined || !Number.isFinite(setting)) return DEFAULT_MAX_HISTORY_CHARS;
	return setting > 0 ? Math.floor(setting) : Number.POSITIVE_INFINITY;
}

/**
 * Returns the message texts to send. Within budget, nothing changes. Otherwise tool results before
 * the latest user message are shortened first (the current exchange stays intact), then the oldest
 * messages are dropped, never the latest one, and a note says how many were left out.
 */
export function fitHistory(entries: readonly HistoryEntry[], budget: number): string[] {
	const texts = entries.map((entry) => entry.text);
	if (total(texts) <= budget) return texts;

	const currentExchange = entries.findLastIndex((entry) => entry.role === "user");
	for (let index = 0; index < currentExchange; index += 1) {
		if (entries[index].role === "toolResult") texts[index] = shorten(texts[index]);
	}
	if (total(texts) <= budget) return texts;

	let dropped = 0;
	let size = total(texts);
	while (dropped < texts.length - 1 && size > budget) {
		size -= texts[dropped].length;
		dropped += 1;
	}
	if (dropped === 0) return texts;
	return [
		`[${dropped} earlier message${dropped === 1 ? "" : "s"} omitted to stay within chat.maxHistoryChars]`,
		...texts.slice(dropped),
	];
}

function shorten(text: string): string {
	if (text.length <= SHORTENED_TOOL_RESULT_CHARS) return text;
	const head = Math.floor((SHORTENED_TOOL_RESULT_CHARS * 2) / 3);
	const tail = SHORTENED_TOOL_RESULT_CHARS - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n[… ${omitted} characters of older tool output omitted …]\n${text.slice(-tail)}`;
}

function total(texts: readonly string[]): number {
	return texts.reduce((sum, text) => sum + text.length, 0);
}
