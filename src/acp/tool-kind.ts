/** @file ACP tool kinds (`ToolKind` in the protocol); a fixed list, so safe to trace. */
import { coerceString } from "../utils/coerce.ts";

export const ACP_TOOL_KINDS = [
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other",
] as const;

export type AcpToolKind = (typeof ACP_TOOL_KINDS)[number];

/** Returns the kind when it is a known ACP tool kind, "other" for unknown strings. */
export function acpToolKind(value: unknown): AcpToolKind | undefined {
	const kind = coerceString(value);
	if (kind === undefined) return undefined;
	return (ACP_TOOL_KINDS as readonly string[]).includes(kind) ? (kind as AcpToolKind) : "other";
}
