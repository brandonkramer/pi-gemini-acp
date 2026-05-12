/**
 * Ensures direct fetch work only targets public HTTP(S) URLs to reduce SSRF and local-network
 * security risk.
 *
 * KNOWN RESIDUAL: this function validates _the hostname string_. It does NOT perform DNS
 * resolution. A public-looking domain can resolve to a private IP at fetch time (DNS rebinding, or
 * just a misconfigured DNS record). For full SSRF defense you'd need to:
 *
 * 1. Dns.lookup() the hostname,
 * 2. Validate the resolved IP against the same private/link-local/IPv4-mapped checks,
 * 3. Pin the connection to the validated IP (so a second resolution can't rebind).
 *
 * If/when pi-scraper integration lands (task #07), prefer its network-layer enforcement over this
 * string-level check.
 */
export function assertPublicHttpUrl(input: string): URL {
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP(S) source hydration is supported");
	}
	const wasBracketed = url.hostname.startsWith("[");
	const host = url.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		throw new Error("Private/local source hydration is blocked");
	}

	// Handle IPv4-mapped IPv6: extract the embedded IPv4 and validate it.
	const hexMatch = /^::ffff:([0-9a-f]{0,4}):([0-9a-f]{0,4})$/u.exec(host);
	if (hexMatch) {
		const embeddedV4 = hexPairToDotted(hexMatch[1], hexMatch[2]);
		if (!isPublicIPv4(embeddedV4)) {
			throw new Error("Private IPv4 (via IPv4-mapped IPv6) source hydration is blocked");
		}
		return url;
	}

	const dottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(host);
	if (dottedMatch) {
		const embeddedV4 = dottedMatch[1];
		if (!isPublicIPv4(embeddedV4)) {
			throw new Error("Private IPv4 (via IPv4-mapped IPv6) source hydration is blocked");
		}
		return url;
	}

	if (host.startsWith("169.254.")) {
		throw new Error(
			"Link-local IPv4 source hydration is blocked (includes cloud metadata endpoints)",
		);
	}
	if (!isPublicIPv4(host)) {
		throw new Error("Private IPv4 source hydration is blocked");
	}
	if (wasBracketed) {
		// Any high-96-bits-zero (::*) hostname remaining after the ::ffff:* mapped-IPv4 returns above
		// is in ::/96 minus ::ffff:/96 — all special-purpose (unspecified, loopback, IPv4-compatible).
		if (host.startsWith("::")) {
			throw new Error("Private/local IPv6 source hydration is blocked");
		}
		const groups = parseIPv6Groups(host);
		if (groups) {
			for (const cidr of DENIED_IPV6_CIDRS) {
				if (ipv6InCidr(groups, cidr)) {
					throw new Error("Private/local IPv6 source hydration is blocked");
				}
			}
			// Translation prefixes embed an IPv4 in their low bits. IANA marks them globally
			// reachable, but a private/link-local embedded IPv4 is still SSRF-reachable via gateway.
			const embedded = extractEmbeddedIPv4(groups);
			if (embedded && !isPublicIPv4(embedded.addr)) {
				throw new Error(`Private IPv4 (via ${embedded.prefix}) source hydration is blocked`);
			}
		}
	}
	return url;
}

interface DeniedIPv6Cidr {
	readonly prefix: readonly number[];
	readonly bits: number;
}

/**
 * Non-globally-routable IPv6 ranges from the IANA IPv6 Special-Purpose Address Registry. ::/96
 * (minus ::ffff:* mapped IPv4) is covered by the host.startsWith("::") check above.
 */
const DENIED_IPV6_CIDRS: readonly DeniedIPv6Cidr[] = [
	{ prefix: [0xfc00], bits: 7 }, // ULA fc00::/7
	{ prefix: [0xfe80], bits: 10 }, // link-local fe80::/10
	{ prefix: [0xfec0], bits: 10 }, // deprecated site-local fec0::/10
	{ prefix: [0xff00], bits: 8 }, // multicast ff00::/8
	{ prefix: [0x0100], bits: 64 }, // discard 100::/64 (RFC 6666)
	{ prefix: [0x0100, 0x0000, 0x0000, 0x0001], bits: 64 }, // dummy 100:0:0:1::/64 (IANA)
	{ prefix: [0x0064, 0xff9b, 0x0001], bits: 48 }, // local-use NAT64 64:ff9b:1::/48 (RFC 8215)
	{ prefix: [0x2001, 0x0db8], bits: 32 }, // documentation 2001:db8::/32 (RFC 3849)
	{ prefix: [0x2001, 0x0002], bits: 48 }, // benchmark 2001:2::/48 (RFC 5180)
	{ prefix: [0x3fff], bits: 20 }, // documentation 3fff::/20 (RFC 9637)
	{ prefix: [0x5f00], bits: 16 }, // SRv6 SIDs 5f00::/16 (RFC 9602)
];

/** Parses a canonical-form IPv6 hostname into 8 16-bit groups. Returns null on any parse failure. */
function parseIPv6Groups(host: string): number[] | null {
	if (!host.includes(":")) return null;
	const parts = host.split("::");
	if (parts.length > 2) return null;
	const head = parts[0] === "" ? [] : parts[0].split(":");
	const tail = parts.length === 2 && parts[1] !== "" ? parts[1].split(":") : [];
	const explicit = head.length + tail.length;
	if (explicit > 8) return null;
	if (parts.length === 1 && explicit !== 8) return null;
	const fillCount = parts.length === 2 ? 8 - explicit : 0;
	const groups: number[] = [];
	for (const part of head) {
		const n = parseInt(part, 16);
		if (Number.isNaN(n) || n < 0 || n > 0xffff || !/^[0-9a-f]+$/u.test(part)) return null;
		groups.push(n);
	}
	for (let i = 0; i < fillCount; i += 1) groups.push(0);
	for (const part of tail) {
		const n = parseInt(part, 16);
		if (Number.isNaN(n) || n < 0 || n > 0xffff || !/^[0-9a-f]+$/u.test(part)) return null;
		groups.push(n);
	}
	return groups.length === 8 ? groups : null;
}

function ipv6InCidr(groups: number[], cidr: DeniedIPv6Cidr): boolean {
	const fullGroups = Math.floor(cidr.bits / 16);
	const remainderBits = cidr.bits % 16;
	for (let i = 0; i < fullGroups; i += 1) {
		if (groups[i] !== (cidr.prefix[i] ?? 0)) return false;
	}
	if (remainderBits === 0) return true;
	const mask = (0xffff << (16 - remainderBits)) & 0xffff;
	return (groups[fullGroups] & mask) === ((cidr.prefix[fullGroups] ?? 0) & mask);
}

interface DeniedIPv4Cidr {
	readonly prefix: number;
	readonly bits: number;
}

/**
 * Non-globally-reachable IPv4 ranges from the IANA IPv4 Special-Purpose Address Registry. Encoded
 * as 32-bit unsigned integers for masked-prefix comparison.
 */
const DENIED_IPV4_CIDRS: readonly DeniedIPv4Cidr[] = [
	{ prefix: 0x00000000, bits: 8 }, // 0.0.0.0/8 "this network"
	{ prefix: 0x0a000000, bits: 8 }, // 10.0.0.0/8 private
	{ prefix: 0x64400000, bits: 10 }, // 100.64.0.0/10 CGNAT
	{ prefix: 0x7f000000, bits: 8 }, // 127.0.0.0/8 loopback
	{ prefix: 0xa9fe0000, bits: 16 }, // 169.254.0.0/16 link-local + IMDS
	{ prefix: 0xac100000, bits: 12 }, // 172.16.0.0/12 private
	{ prefix: 0xc0000000, bits: 24 }, // 192.0.0.0/24 IETF protocol assignments (with allowlist below)
	{ prefix: 0xc0000200, bits: 24 }, // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
	{ prefix: 0xc0a80000, bits: 16 }, // 192.168.0.0/16 private
	{ prefix: 0xc6120000, bits: 15 }, // 198.18.0.0/15 benchmark (RFC 2544)
	{ prefix: 0xc0586300, bits: 24 }, // 192.88.99.0/24 deprecated 6to4 relay anycast (RFC 7526, IANA)
	{ prefix: 0xc6336400, bits: 24 }, // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
	{ prefix: 0xcb007100, bits: 24 }, // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
	{ prefix: 0xe0000000, bits: 4 }, // 224.0.0.0/4 multicast (IANA IPv4 Multicast Address Space)
	{ prefix: 0xf0000000, bits: 4 }, // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
];

/**
 * IANA-listed globally-reachable exceptions inside otherwise-denied 192.0.0.0/24: 192.0.0.9 — Port
 * Control Protocol Anycast (RFC 7723) 192.0.0.10 — TURN Anycast (RFC 8155)
 */
const PUBLIC_IPV4_EXCEPTIONS: ReadonlySet<number> = new Set([0xc0000009, 0xc000000a]);

function ipv4ToInt(addr: string): number | null {
	const parts = addr.split(".");
	if (parts.length !== 4) return null;
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/u.test(part)) return null;
		const n = parseInt(part, 10);
		if (n > 255) return null;
		result = (result * 256 + n) >>> 0;
	}
	return result;
}

function isPublicIPv4(addr: string): boolean {
	const int = ipv4ToInt(addr);
	// Non-IPv4 strings (DNS names, IPv6) pass through; their checks live elsewhere.
	if (int === null) return true;
	if (PUBLIC_IPV4_EXCEPTIONS.has(int)) return true;
	for (const cidr of DENIED_IPV4_CIDRS) {
		const mask = cidr.bits === 0 ? 0 : (0xffffffff << (32 - cidr.bits)) >>> 0;
		if ((int & mask) === (cidr.prefix & mask)) return false;
	}
	return true;
}

function hexPairToDotted(hi: string, lo: string): string {
	const h = parseInt(hi || "0", 16);
	const l = parseInt(lo || "0", 16);
	return `${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`;
}

/**
 * Extracts the embedded IPv4 address from IPv6 translation/transition prefixes. Returns null when
 * the address isn't in a recognized translation prefix.
 */
function extractEmbeddedIPv4(groups: number[]): { addr: string; prefix: string } | null {
	// NAT64 well-known 64:ff9b::/96 — IPv4 in low 32 bits (groups[6..7]).
	if (
		groups[0] === 0x0064 &&
		groups[1] === 0xff9b &&
		groups[2] === 0 &&
		groups[3] === 0 &&
		groups[4] === 0 &&
		groups[5] === 0
	) {
		return {
			addr: groupsToDottedIPv4(groups[6], groups[7]),
			prefix: "NAT64 well-known 64:ff9b::/96",
		};
	}
	// 6to4 2002::/16 — IPv4 in groups[1..2].
	if (groups[0] === 0x2002) {
		return {
			addr: groupsToDottedIPv4(groups[1], groups[2]),
			prefix: "6to4 2002::/16",
		};
	}
	return null;
}

function groupsToDottedIPv4(hi: number, lo: number): string {
	return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
