import type { GeminiAcpClientCachePurpose } from "./client-cache.ts";
/** @file Cache-key formatting for warm Gemini ACP clients. */
import type { GeminiAcpCommandSettings } from "./client.ts";

/** Returns the stable JSON key used for warm Gemini ACP client cache entries. */
export function clientCacheKey(
	settings: GeminiAcpCommandSettings,
	purpose: GeminiAcpClientCachePurpose,
): string {
	return JSON.stringify({
		purpose,
		command: settings.command,
		args: settings.args ?? [],
		permissionPolicy: {
			filesystemRead: settings.permissionPolicy?.filesystemRead === true,
			filesystemWrite: settings.permissionPolicy?.filesystemWrite === true,
			terminal: settings.permissionPolicy?.terminal === true,
		},
		env: settings.env
			? Object.fromEntries(Object.entries(settings.env).sort(([a], [b]) => a.localeCompare(b)))
			: undefined,
	});
}
