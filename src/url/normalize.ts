const TRACKING_PARAMS = new Set([
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"fbclid",
	"gclid",
]);

export function normalizeUrl(input: string | URL): string {
	const url = new URL(input.toString());
	url.hostname = url.hostname.toLowerCase();
	if (
		(url.protocol === "https:" && url.port === "443") ||
		(url.protocol === "http:" && url.port === "80")
	) {
		url.port = "";
	}
	// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot keys; we mutate the iterator below
	for (const key of [...url.searchParams.keys()]) {
		if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
	}
	const sorted = [...url.searchParams.entries()].toSorted(([a], [b]) => a.localeCompare(b));
	url.search = "";
	for (const [key, value] of sorted) url.searchParams.append(key, value);
	url.hash = "";
	if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
	return url.toString();
}
