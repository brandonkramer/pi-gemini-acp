/**
 * @file Builds one assistant message from streamed Gemini ACP output and emits Pi's stream events
 *   for it. Pi expects every content block to be opened with `*_start`, grown only through
 *   `*_delta`, and closed with `*_end` before the next block starts.
 */
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	TextContent,
	ThinkingContent,
} from "@earendil-works/pi-ai";

type Block = TextContent | ThinkingContent;

/** Appends text and thinking output as balanced content blocks. */
export class AssistantMessageBuilder {
	private readonly stream: AssistantMessageEventStream;
	private readonly base: AssistantMessage;
	private readonly blocks: Block[] = [];
	private open?: Block;

	constructor(stream: AssistantMessageEventStream, base: AssistantMessage) {
		this.stream = stream;
		this.base = base;
	}

	/** Appends visible answer text. */
	appendText(delta: string): void {
		if (!delta) return;
		const block = this.openBlock("text");
		(block as TextContent).text += delta;
		this.stream.push({
			type: "text_delta",
			contentIndex: this.blocks.length - 1,
			delta,
			partial: this.snapshot(),
		});
	}

	/** Appends Gemini's reasoning or progress notes, shown as thinking. */
	appendThinking(delta: string): void {
		if (!delta) return;
		const block = this.openBlock("thinking");
		(block as ThinkingContent).thinking += delta;
		this.stream.push({
			type: "thinking_delta",
			contentIndex: this.blocks.length - 1,
			delta,
			partial: this.snapshot(),
		});
	}

	/** Appends a progress line to the thinking text, starting on a new line. */
	appendThinkingLine(line: string): void {
		const open = this.open?.type === "thinking" ? this.open : undefined;
		const separator = open && open.thinking.length > 0 && !open.thinking.endsWith("\n") ? "\n" : "";
		this.appendThinking(`${separator}${line}\n`);
	}

	/** Closes the open block and returns the content of the finished message. */
	finish(): Block[] {
		this.closeOpenBlock();
		return this.blocks.map((block) => ({ ...block }));
	}

	/** Visible answer text emitted so far. */
	text(): string {
		return this.blocks
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	private openBlock(type: Block["type"]): Block {
		if (this.open?.type === type) return this.open;
		this.closeOpenBlock();
		const block: Block = type === "text" ? { type, text: "" } : { type, thinking: "" };
		this.blocks.push(block);
		this.open = block;
		this.stream.push({
			type: type === "text" ? "text_start" : "thinking_start",
			contentIndex: this.blocks.length - 1,
			partial: this.snapshot(),
		});
		return block;
	}

	private closeOpenBlock(): void {
		const block = this.open;
		if (!block) return;
		this.open = undefined;
		const contentIndex = this.blocks.length - 1;
		if (block.type === "text") {
			this.stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: this.snapshot(),
			});
		} else {
			this.stream.push({
				type: "thinking_end",
				contentIndex,
				content: block.thinking,
				partial: this.snapshot(),
			});
		}
	}

	/** Fresh copies, so a consumer that keeps a partial never sees later changes. */
	private snapshot(): AssistantMessage {
		return { ...this.base, content: this.blocks.map((block) => ({ ...block })) };
	}
}
