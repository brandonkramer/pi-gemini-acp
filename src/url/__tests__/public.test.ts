/** @file Tests for SSRF URL validation. */
import { describe, expect, it } from "vitest";

import { assertPublicHttpUrl } from "../public.ts";

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
			// IETF protocol assignments 192.0.0.0/24 (except .9 and .10 — allowlisted)
			["http://192.0.0.1/", "Private IPv4"],
			["http://192.0.0.8/", "Private IPv4"],
			["http://192.0.0.11/", "Private IPv4"],
			// TEST-NET-1/2/3 documentation ranges (RFC 5737)
			["http://192.0.2.1/", "Private IPv4"],
			["http://198.51.100.42/", "Private IPv4"],
			["http://203.0.113.7/", "Private IPv4"],
			// benchmark 198.18.0.0/15 (RFC 2544)
			["http://198.18.0.1/", "Private IPv4"],
			["http://198.19.255.255/", "Private IPv4"],
			// Class E reserved 240.0.0.0/4
			["http://240.0.0.1/", "Private IPv4"],
			["http://254.254.254.254/", "Private IPv4"],
			// limited broadcast 255.255.255.255 (covered by 240/4)
			["http://255.255.255.255/", "Private IPv4"],
			// IPv4 multicast 224.0.0.0/4
			["http://224.0.0.1/", "Private IPv4"],
			["http://239.255.255.255/", "Private IPv4"],
			// deprecated 6to4 relay anycast 192.88.99.0/24 (RFC 7526, IANA)
			["http://192.88.99.0/", "Private IPv4"],
			["http://192.88.99.1/", "Private IPv4"],
			["http://192.88.99.2/", "Private IPv4"],
			["http://192.88.99.255/", "Private IPv4"],
			// embedded private IPv4 via NAT64 (198.18.0.1 → c612:1)
			["http://[64:ff9b::c612:1]/", "Private IPv4 \\(via NAT64"],
			// embedded TEST-NET via 6to4 (192.0.2.1 → c000:201)
			["http://[2002:c000:201::]/", "Private IPv4 \\(via 6to4"],
			// embedded 6a44 relay anycast via NAT64 (192.88.99.2 → c058:6302)
			["http://[64:ff9b::c058:6302]/", "Private IPv4 \\(via NAT64"],
			// embedded 6a44 relay anycast via 6to4
			["http://[2002:c058:6302::]/", "Private IPv4 \\(via 6to4"],
			// embedded multicast via NAT64 (224.0.0.1 → e000:1)
			["http://[64:ff9b::e000:1]/", "Private IPv4 \\(via NAT64"],
			// embedded multicast via 6to4
			["http://[2002:e000:1::]/", "Private IPv4 \\(via 6to4"],
			["http://[::]/", "Private/local IPv6"],
			["http://[::1]/", "Private/local IPv6"],
			// any high-96-bits-zero (::*) is non-public:
			["http://[::abcd:1234]/", "Private/local IPv6"],
			["http://[::2606:4700]/", "Private/local IPv6"],
			// IPv4-compatible IPv6 ([::127.0.0.1] normalizes to [::7f00:1])
			["http://[::7f00:1]/", "Private/local IPv6"],
			["http://[fc00::1]/", "Private/local IPv6"],
			["http://[fd12:3456:789a::1]/", "Private/local IPv6"],
			["http://[fe80::1]/", "Private/local IPv6"],
			// site-local fec0::/10 (deprecated but still real)
			["http://[fec0::1]/", "Private/local IPv6"],
			["http://[feff::1]/", "Private/local IPv6"],
			// multicast ff00::/8
			["http://[ff02::1]/", "Private/local IPv6"],
			["http://[ff05::1:3]/", "Private/local IPv6"],
			// discard-only 100::/64 (RFC 6666)
			["http://[100::1]/", "Private/local IPv6"],
			// documentation 2001:db8::/32 (RFC 3849)
			["http://[2001:db8::1]/", "Private/local IPv6"],
			["http://[2001:db8:1234:5678::1]/", "Private/local IPv6"],
			// benchmark 2001:2::/48 (RFC 5180) — must catch non-compressed forms too
			["http://[2001:2::1]/", "Private/local IPv6"],
			["http://[2001:2:0:abcd::1]/", "Private/local IPv6"],
			// documentation 3fff::/20 (RFC 9637)
			["http://[3fff::1]/", "Private/local IPv6"],
			["http://[3fff:0fff::1]/", "Private/local IPv6"],
			// SRv6 SIDs 5f00::/16 (RFC 9602)
			["http://[5f00::1]/", "Private/local IPv6"],
			["http://[5f00:abcd:1234::1]/", "Private/local IPv6"],
			// local-use NAT64 64:ff9b:1::/48 (RFC 8215)
			["http://[64:ff9b:1::1]/", "Private/local IPv6"],
			["http://[64:ff9b:1:abcd::1]/", "Private/local IPv6"],
			// dummy 100:0:0:1::/64 (IANA)
			["http://[100:0:0:1::1]/", "Private/local IPv6"],
			["http://[100:0:0:1:abcd::1]/", "Private/local IPv6"],
			// NAT64 well-known with private embedded IPv4 (127.0.0.1 → 7f00:1)
			["http://[64:ff9b::7f00:1]/", "Private IPv4 \\(via NAT64"],
			// 6to4 with private embedded IPv4 (192.168.1.1 → c0a8:101)
			["http://[2002:c0a8:101::]/", "Private IPv4 \\(via 6to4"],
			// 6to4 with link-local embedded IPv4 (169.254.169.254 cloud metadata → a9fe:a9fe)
			["http://[2002:a9fe:a9fe::]/", "Private IPv4 \\(via 6to4"],
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
			// global unicast in 2000::/3 outside reserved sub-ranges
			"https://[2001:4860:4860::8888]/",
			"https://[2400:cb00::1]/",
			// just outside 2001:2::/48 (third group != 0)
			"https://[2001:2:1::1]/",
			// just outside 3fff::/20 (top 4 bits of second group nonzero)
			"https://[3fff:1000::1]/",
			// just outside 5f00::/16
			"https://[5f01::1]/",
			"https://[5e00::1]/",
			// just outside 100::/64 (lower 64 bits of /64 prefix nonzero in upper groups)
			"https://[100:0:0:abcd::1]/",
			// just outside 64:ff9b:1::/48
			"https://[64:ff9b:2::1]/",
			// NAT64 well-known 64:ff9b::/96 with public IPv4 — globally reachable per IANA, allowed
			"https://[64:ff9b::8.8.8.8]/",
			// 6to4 with public embedded IPv4 (8.8.8.8 → 808:808)
			"https://[2002:808:808::]/",
			// just outside dummy 100:0:0:1::/64 (4th group != 1)
			"https://[100:0:0:2::1]/",
			// just outside 172.16-31
			"https://172.15.0.1/",
			"https://172.32.0.1/",
			// just outside 100.64.0.0/10
			"https://100.63.255.255/",
			"https://100.128.0.1/",
			// just outside 169.254.0.0/16
			"https://169.255.0.1/",
			// IANA-listed globally-reachable exceptions inside 192.0.0.0/24
			"https://192.0.0.9/", // PCP Anycast (RFC 7723)
			"https://192.0.0.10/", // TURN Anycast (RFC 8155)
			// just outside 192.0.0.0/24
			"https://192.0.1.1/",
			// just outside 192.0.2.0/24 TEST-NET-1
			"https://192.0.3.1/",
			// just outside 198.18.0.0/15
			"https://198.17.0.1/",
			"https://198.20.0.1/",
			// just outside 224.0.0.0/4 multicast
			"https://223.255.255.255/",
			// just outside 192.88.99.0/24 deprecated 6to4 relay
			"https://192.88.98.255/",
			"https://192.88.100.0/",
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
