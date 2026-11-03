// Robots directives from `<meta name="robots">` (or a crawler-named meta such as `googlebot`) and `X-Robots-Tag`
// headers, scoped by user agent: scope `*` is the generic rule, any other scope is the lowercased crawler token.
import type { HtmlSignals } from "./html.ts";

export interface RobotsDirective {
	source: "meta" | "header";
	scope: string;
	name: string; // lowercased directive: noindex, nofollow, none, max-snippet, unavailable_after, …
	value: string | null; // the part after `:` for valued directives
	raw: string; // the whole meta content or header value
	locator: string; // html:meta[name=…] or header:x-robots-tag
}

const VALUED: Record<string, true> = {
	"max-snippet": true,
	"max-image-preview": true,
	"max-video-preview": true,
	unavailable_after: true,
};
const KNOWN: Record<string, true> = {
	all: true,
	index: true,
	follow: true,
	noindex: true,
	nofollow: true,
	none: true,
	nosnippet: true,
	indexifembedded: true,
	"max-snippet": true,
	"max-image-preview": true,
	"max-video-preview": true,
	noimageindex: true,
	notranslate: true,
	unavailable_after: true,
	noarchive: true,
	nocache: true,
	nositelinkssearchbox: true,
	noodp: true,
	noydir: true,
};

// Splits a comma-separated directive list. A token `<ua>: <directive>` whose head is not itself a directive sets the
// scope for the rest of the list (Google's `X-Robots-Tag: googlebot: noindex, nofollow`). Commas inside an
// unavailable_after date (RFC 850 dates carry one) are rejoined.
export function parseDirectiveList(
	list: string,
	defaultScope: string,
	allowScopePrefix: boolean,
): { scope: string; name: string; value: string | null }[] {
	const out: { scope: string; name: string; value: string | null }[] = [];
	let scope = defaultScope;
	for (const piece of list.split(",")) {
		let token = piece.trim();
		if (!token) continue;
		const head = token.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (allowScopePrefix && head?.[1] && !KNOWN[head[1].toLowerCase()]) {
			scope = head[1].toLowerCase();
			token = (head[2] ?? "").trim();
			if (!token) continue;
		}
		const m = token.match(/^([A-Za-z_-]+)\s*(?::\s*(.*))?$/);
		const name = (m?.[1] ?? token).toLowerCase();
		const prev = out[out.length - 1];
		if (!KNOWN[name] && prev?.name === "unavailable_after") {
			prev.value = `${prev.value ?? ""}, ${token}`;
			continue;
		}
		out.push({ scope, name, value: VALUED[name] ? (m?.[2] ?? "").trim() : null });
	}
	return out;
}

export function robotsDirectives(signals: HtmlSignals | null, headers: Record<string, string> | null): RobotsDirective[] {
	const out: RobotsDirective[] = [];
	for (const meta of signals?.metas ?? []) {
		if (meta.key !== "name") continue;
		if (meta.name !== "robots" && !/bot/.test(meta.name)) continue;
		const scope = meta.name === "robots" ? "*" : meta.name;
		for (const d of parseDirectiveList(meta.content, scope, false))
			out.push({ source: "meta", ...d, raw: meta.content, locator: `html:meta[name=${meta.name}]` });
	}
	const header = headers?.["x-robots-tag"];
	if (header)
		for (const d of parseDirectiveList(header, "*", true)) out.push({ source: "header", ...d, raw: header, locator: "header:x-robots-tag" });
	return out;
}

// Directives that bind Google: generic or googlebot-scoped. `none` implies noindex and nofollow.
export function googleDirectives(ds: RobotsDirective[]): RobotsDirective[] {
	return ds.filter((d) => d.scope === "*" || d.scope === "googlebot");
}

export function hasDirective(ds: RobotsDirective[], name: string): RobotsDirective | undefined {
	return ds.find((d) => d.name === name || (d.name === "none" && (name === "noindex" || name === "nofollow")));
}
