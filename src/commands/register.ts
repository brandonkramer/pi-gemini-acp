import type { GeminiCommand, PiCommandRegistrar } from "./define.js";
import { geminiLoginHelpCommand } from "./gemini-login-help.js";
import { geminiSetModelCommand } from "./gemini-set-model.js";
import { geminiSetPermissionPolicyCommand } from "./gemini-set-permission-policy.js";

/** Slash commands exposed by the Gemini ACP Pi extension. */
export const geminiAcpCommands = [
	geminiLoginHelpCommand,
	geminiSetModelCommand,
	geminiSetPermissionPolicyCommand,
] as const;

/** Registers Gemini ACP slash commands with a Pi host. */
export function registerGeminiAcpCommands(pi: PiCommandRegistrar): void {
	for (const command of geminiAcpCommands) {
		pi.registerCommand(command as GeminiCommand);
	}
}
