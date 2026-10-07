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

	it("advertises readTextFile only when the policy allows reads and the session serves them", () => {
		const policy = { filesystemRead: true, filesystemWrite: true };
		expect(permissionPolicyCapabilities(policy).fs).toEqual({
			readTextFile: false,
			writeTextFile: false,
		});
		expect(permissionPolicyCapabilities(policy, { servesFileReads: true }).fs).toEqual({
			readTextFile: true,
			writeTextFile: false,
		});
		expect(
			permissionPolicyCapabilities(
				{ filesystemRead: false, filesystemWrite: true },
				{ servesFileReads: true },
			).fs,
		).toEqual({ readTextFile: false, writeTextFile: false });
		expect(permissionPolicyCapabilities({ terminal: true }).terminal).toBe(false);
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
