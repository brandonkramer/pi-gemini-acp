import type { PiToolShell, ResultEnvelope } from "../types.js";
import type { PiCommandContext } from "./define.js";

type RequiredDialogUi = Required<
	Pick<
		NonNullable<PiCommandContext["ui"]>,
		"select" | "confirm" | "input" | "notify"
	>
>;

export type InteractiveCommandContext = PiCommandContext & {
	ui: NonNullable<PiCommandContext["ui"]> & RequiredDialogUi;
};

export function hasInteractiveUi(
	ctx: PiCommandContext | undefined,
): ctx is InteractiveCommandContext {
	return Boolean(
		ctx?.hasUI !== false &&
			ctx?.ui?.select &&
			ctx.ui.confirm &&
			ctx.ui.input &&
			ctx.ui.notify,
	);
}

export function notifyResult(
	ctx: InteractiveCommandContext,
	result: Pick<PiToolShell<ResultEnvelope<unknown>>, "content" | "details">,
): void {
	const text = result.content?.[0]?.text;
	if (!text) return;
	const hasError = Boolean(result.details?.error?.code);
	ctx.ui.notify(text, hasError ? "error" : "info");
}
