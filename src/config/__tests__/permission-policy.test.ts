import { describe, expect, it } from "vitest";
import {
	describePermissionPolicy,
	permissionPolicyCapabilities,
	requirePermissionCapability,
	resolvePermissionPolicy,
} from "../permission-policy.js";

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
		expect(describePermissionPolicy()).toContain(
			"no filesystem or terminal access",
		);
	});

	it("resolves explicit broader modes", () => {
		expect(
			permissionPolicyCapabilities({ mode: "file-read-write" }).fs,
		).toEqual({ readTextFile: true, writeTextFile: true });
		expect(permissionPolicyCapabilities({ mode: "terminal" }).terminal).toBe(
			true,
		);
	});

	it("returns structured denial errors for advanced capabilities", () => {
		expect(requirePermissionCapability(undefined, "filesystemRead")?.code).toBe(
			"GEMINI_ACP_PERMISSION_POLICY_DENIED",
		);
		expect(
			requirePermissionCapability({ mode: "file-read" }, "filesystemRead"),
		).toBeUndefined();
		expect(
			requirePermissionCapability({ mode: "file-read" }, "filesystemWrite")
				?.message,
		).toContain("file-read");
	});
});
