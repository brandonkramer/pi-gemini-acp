/**
 * Ensures direct fetch work only targets public HTTP(S) URLs to reduce SSRF and local-network
 * security risk.
 */
export function assertPublicHttpUrl(input: string): URL {
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP(S) source hydration is supported");
	}
	const host = url.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		throw new Error("Private/local source hydration is blocked");
	}
	if (
		/^(127|10|0)\./u.test(host) ||
		host.startsWith("192.168.") ||
		/^172\.(1[6-9]|2\d|3[0-1])\./u.test(host)
	) {
		throw new Error("Private IPv4 source hydration is blocked");
	}
	if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
		throw new Error("Private IPv6 source hydration is blocked");
	}
	return url;
}
