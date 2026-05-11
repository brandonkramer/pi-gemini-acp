import { describe, expect, it } from "vitest";

import type { GeminiAcpPermissionPolicy } from "../../types.ts";
import {
	describePermissionPolicy,
	migrateLegacyPermissionPolicy,
	permissionPolicyCapabilities,
	requirePermissionCapability,
	resolvePermissionPolicy,
} from "../permission-policy.ts";

describe("Gemini ACP permission policy", () => {
	it("defaults to restrictive client capabilities", () => {
		expect(resolvePermissionPolicy()).toMatchObject({
			mode: "restrictive",
			filesystemRead: false,
			filesystemWrite: false,
			terminal: false,
		});
		expect(permissionPolicyCapabilities()).toEqual({
			auth: { terminal: false },
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		});
		expect(describePermissionPolicy()).toContain("no filesystem or terminal access");
	});

	it("resolves explicit capability booleans", () => {
		expect(
			permissionPolicyCapabilities({
				filesystemRead: true,
				filesystemWrite: true,
			}).fs,
		).toEqual({ readTextFile: true, writeTextFile: true });
		expect(permissionPolicyCapabilities({ terminal: true }).terminal).toBe(true);
		expect(describePermissionPolicy({ filesystemRead: true })).toContain(
			"file-read: filesystem read",
		);
	});

	it("migrates legacy mode policies while reading", () => {
		const legacy = {
			mode: "file-read",
			reason: "old config",
		} as GeminiAcpPermissionPolicy & { mode: "file-read" };

		expect(migrateLegacyPermissionPolicy(legacy)).toMatchObject({
			filesystemRead: true,
			filesystemWrite: false,
			terminal: false,
			reason: "old config",
		});
		expect(resolvePermissionPolicy(legacy)).toMatchObject({
			mode: "file-read",
			filesystemRead: true,
		});
	});

	it("returns structured denial errors for advanced capabilities", () => {
		expect(requirePermissionCapability(undefined, "filesystemRead")?.code).toBe(
			"GEMINI_ACP_PERMISSION_POLICY_DENIED",
		);
		expect(requirePermissionCapability({ filesystemRead: true }, "filesystemRead")).toBeUndefined();
		expect(
			requirePermissionCapability({ filesystemRead: true }, "filesystemWrite")?.message,
		).toContain("/gemini-config permissions");
	});
});
