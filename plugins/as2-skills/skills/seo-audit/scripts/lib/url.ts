// URL comparison used across rules: scheme and host lowercased, default port dropped, fragment ignored (rules.md
// CAN-004 detection basis).

export function normaliseUrl(u: string, base?: string): string | null {
	let url: URL;
	try {
		url = new URL(u, base);
	} catch {
		return null;
	}
	url.hash = "";
	return url.href; // WHATWG URL already lowercases scheme and host and drops the default port
}

export function sameUrl(a: string, b: string): boolean {
	const x = normaliseUrl(a);
	return x !== null && x === normaliseUrl(b);
}

export function isAbsoluteHttpUrl(s: string): boolean {
	return /^https?:\/\/[^/\s]/i.test(s.trim());
}

export function pathOf(u: string): string {
	try {
		const url = new URL(u);
		return `${url.pathname}${url.search}`;
	} catch {
		return u;
	}
}

// Truncates an observed value to the report contract's 300 characters.
export function clip(s: string, max = 300): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface LinkHeaderEntry {
	href: string;
	params: Record<string, string>; // lowercased names; `rel` lowercased
}

// RFC 8288 `Link` header: `<uri>; rel="canonical", <uri2>; rel="alternate"; hreflang="de"`.
export function parseLinkHeader(value: string | undefined): LinkHeaderEntry[] {
	if (!value) return [];
	const out: LinkHeaderEntry[] = [];
	for (const m of value.matchAll(/<([^>]*)>((?:\s*;\s*[^;,=\s]+(?:\s*=\s*(?:"[^"]*"|[^;,\s]*))?)*)/g)) {
		const params: Record<string, string> = {};
		for (const p of (m[2] ?? "").matchAll(/;\s*([^;,=\s]+)(?:\s*=\s*(?:"([^"]*)"|([^;,\s]*)))?/g)) {
			const name = (p[1] ?? "").toLowerCase();
			const v = p[2] ?? p[3] ?? "";
			params[name] = name === "rel" ? v.toLowerCase() : v;
		}
		out.push({ href: (m[1] ?? "").trim(), params });
	}
	return out;
}
