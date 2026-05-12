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
	if (
		wasBracketed &&
		(host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80"))
	) {
		throw new Error("Private IPv6 source hydration is blocked");
	}
	return url;
}

function isPublicIPv4(addr: string): boolean {
	return !(
		/^(127|10|0)\./u.test(addr) ||
		addr.startsWith("192.168.") ||
		/^172\.(1[6-9]|2\d|3[0-1])\./u.test(addr) ||
		addr.startsWith("169.254.") ||
		/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(addr)
	);
}

function hexPairToDotted(hi: string, lo: string): string {
	const h = parseInt(hi || "0", 16);
	const l = parseInt(lo || "0", 16);
	return `${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`;
}
