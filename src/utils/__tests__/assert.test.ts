/** @file Tests for SSRF URL validation. */
import { describe, expect, it } from "vitest";

import { assertPublicHttpUrl } from "../assert.ts";

describe("assertPublicHttpUrl", () => {
	describe("blocks private and internal targets", () => {
		it.each([
			["http://localhost/", "Private/local"],
			["http://foo.localhost/", "Private/local"],
			["http://service.internal/", "Private/local"],
			["http://service.local/", "Private/local"],
			["http://127.0.0.1/", "Private IPv4"],
			["http://10.0.0.1/", "Private IPv4"],
			["http://192.168.1.1/", "Private IPv4"],
			["http://172.16.0.1/", "Private IPv4"],
			["http://172.31.255.255/", "Private IPv4"],
			["http://169.254.0.1/", "Link-local"],
			// cloud metadata endpoint
			["http://169.254.169.254/", "Link-local"],
			["http://100.64.0.1/", "Private IPv4"],
			["http://100.127.255.255/", "Private IPv4"],
			["http://[::1]/", "Private IPv6"],
			["http://[fc00::1]/", "Private IPv6"],
			["http://[fe80::1]/", "Private IPv6"],
			["http://[::ffff:127.0.0.1]/", "via IPv4-mapped IPv6"],
			["http://[::ffff:a9fe:a9fe]/", "via IPv4-mapped IPv6"],
			["http://[::ffff:10.0.0.1]/", "via IPv4-mapped IPv6"],
		])("rejects %s with %s message", (url, expectedFragment) => {
			expect(() => assertPublicHttpUrl(url)).toThrow(new RegExp(expectedFragment, "iu"));
		});
	});

	describe("accepts legitimate public targets", () => {
		it.each([
			"https://example.com/",
			"https://api.example.com/path",
			"https://1.1.1.1/",
			"https://[2606:4700:4700::1111]/",
			// just outside 172.16-31
			"https://172.15.0.1/",
			"https://172.32.0.1/",
			// just outside 100.64.0.0/10
			"https://100.63.255.255/",
			"https://100.128.0.1/",
			// just outside 169.254.0.0/16
			"https://169.255.0.1/",
			// DNS names starting with fc/fd/fe80 are NOT IPv6 private ranges (no brackets)
			"https://fc2.com/",
			"https://fdsa.example.com/",
			"https://fe80.foo.com/",
		])("accepts %s", (url) => {
			expect(() => assertPublicHttpUrl(url)).not.toThrow();
		});
	});

	describe("rejects unsupported schemes", () => {
		it.each(["file:///etc/passwd", "ftp://example.com/", "ws://example.com/"])(
			"rejects %s",
			(url) => {
				expect(() => assertPublicHttpUrl(url)).toThrow(/HTTP/u);
			},
		);
	});
});
