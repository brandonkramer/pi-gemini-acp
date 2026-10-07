/** @file Cache-key formatting for warm Gemini ACP clients. */
import type { GeminiAcpCommandSettings } from "./client.ts";

/** Returns the stable JSON key used for warm Gemini ACP process cache entries. */
export function clientCacheKey(settings: GeminiAcpCommandSettings): string {
	return JSON.stringify({
		command: settings.command,
		args: settings.args ?? [],
		permissionPolicy: {
			filesystemRead: settings.permissionPolicy?.filesystemRead === true,
			filesystemWrite: settings.permissionPolicy?.filesystemWrite === true,
			terminal: settings.permissionPolicy?.terminal === true,
			webFetch: settings.permissionPolicy?.webFetch === true,
		},
		env: settings.env
			? Object.fromEntries(Object.entries(settings.env).toSorted(([a], [b]) => a.localeCompare(b)))
			: undefined,
	});
}
