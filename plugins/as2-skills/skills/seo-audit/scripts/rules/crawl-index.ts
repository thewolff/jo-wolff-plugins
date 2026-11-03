// Crawl and index family: the rules.md categories robots, indexing, canonical, http and sitemap, plus the do-not-flag
// notes that sit on the same evidence. Every check reads Evidence only (see scripts/rules/README.md).
import type { Layer } from "../lib/catalogue.ts";
import { type RobotsDirective, googleDirectives, hasDirective, robotsDirectives } from "../lib/directives.ts";
import type { Check, Hit, RuleContext } from "../lib/engine.ts";
import { declaredCanonicals, type PageEvidence, pageRobotsBlock, redirectNote, type SitemapEvidence } from "../lib/evidence.ts";
import { W3C_DATETIME } from "../lib/sitemap.ts";
import { isAbsoluteHttpUrl, normaliseUrl, pathOf, parseLinkHeader } from "../lib/url.ts";

// A malformed <lastmod>'s shape, so values from one generator share a cause and another format stays its own finding:
// digit runs become 9 and letter runs a ("03/04/2024" and "05/06/2023" are both "9/9/9", "yesterday" is "a").
function lastmodForm(value: string): string {
	return value.replace(/[0-9]+/g, "9").replace(/[A-Za-z]+/g, "a");
}

const TEMPORARY: Record<number, true> = { 302: true, 303: true, 307: true };
const PERMANENT: Record<number, true> = { 301: true, 308: true };
const REDIRECT: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
const CANONICAL_EXTRA_ATTRS = ["hreflang", "lang", "media", "type"];
const NOSNIPPET_ELEMENTS: Record<string, true> = { span: true, div: true, section: true };
const SITEMAP_MAX_URLS = 50_000;
const SITEMAP_MAX_BYTES = 52_428_800; // 50 MiB, uncompressed

const DIRECTIVE_LAYER: Record<RobotsDirective["source"], Layer> = { meta: "raw-html", header: "headers" };
const CANONICAL_AT: Record<"html" | "header", { locator: string; layer: Layer }> = {
	html: { locator: "html:link[rel=canonical]", layer: "raw-html" },
	header: { locator: "header:link", layer: "headers" },
};

// Robots directives that bind Googlebot in the raw response (meta and X-Robots-Tag; headers alone for non-HTML).
function rawDirectives(p: PageEvidence): RobotsDirective[] {
	return googleDirectives(p.raw?.directives ?? robotsDirectives(null, p.fetch.headers));
}

// A hit per distinct locator for the first directive matching `name` in the raw response.
function directiveHits(ctx: RuleContext, name: string, describe: (d: RobotsDirective) => string | null): Hit[] {
	const out: Hit[] = [];
	for (const p of ctx.audited) {
		const seen: Record<string, true> = {};
		for (const d of rawDirectives(p)) {
			if (seen[d.locator] || !(d.name === name || (name !== "nosnippet" && hasDirective([d], name)))) continue;
			const observed = describe(d);
			if (observed === null) continue;
			seen[d.locator] = true;
			out.push({ url: p.fetch.finalUrl, locator: d.locator, layer: DIRECTIVE_LAYER[d.source], observed });
		}
	}
	return out;
}

// The status the first GET saw (sample and canonical targets are fetched without following redirects).
function firstStatus(p: PageEvidence): number | null {
	return p.fetch.hops[0]?.status ?? null;
}

function redirectHops(p: PageEvidence): { n: number; from: string; to: string; status: number }[] {
	const out: { n: number; from: string; to: string; status: number }[] = [];
	p.fetch.hops.forEach((h, i) => {
		if (!REDIRECT[h.status] || !h.location) return;
		const to = normaliseUrl(h.location, h.url);
		if (to) out.push({ n: i + 1, from: h.url, to, status: h.status });
	});
	return out;
}

interface TargetProblems {
	status: number | null; // the first response's status, when it is not 200
	noindex: boolean;
	disallowed: boolean;
	canonical: string | null; // a declared canonical naming another URL
}

// Why a URL fetched with one GET is not a good index target: the shared core of HEU-02, SMP-004 and BNG-002.
function targetProblems(ctx: RuleContext, url: string, p: PageEvidence): TargetProblems {
	const status = firstStatus(p);
	const own = normaliseUrl(url);
	return {
		status: status === 200 ? null : status,
		noindex: !!hasDirective(rawDirectives(p), "noindex"),
		disallowed: ctx.robotsAllowed(url) === false,
		canonical: declaredCanonicals(p).find((c) => c.resolved && c.resolved !== own)?.resolved ?? null,
	};
}

function fetchedSitemaps(ctx: RuleContext): SitemapEvidence[] {
	return ctx.evidence.sites.flatMap((s) => s.sitemaps.filter((m) => m.fetch?.status === 200));
}

function sitemapOf(ctx: RuleContext, loc: string): { sitemap: SitemapEvidence; line: number; loc: string } | null {
	for (const s of fetchedSitemaps(ctx))
		for (const u of s.parsed?.urls ?? []) if (u.loc && normaliseUrl(u.loc) === loc) return { sitemap: s, line: u.locLine, loc: u.loc };
	return null;
}

// Hits for one-GET problems of the sitemap sample, each located on the sitemap line that lists the URL.
function sampleHits(ctx: RuleContext, reasonsOf: (p: TargetProblems) => string[]): Hit[] {
	const out: Hit[] = [];
	for (const site of ctx.evidence.sites)
		for (const loc of site.sample) {
			const p = ctx.page(loc);
			const where = sitemapOf(ctx, loc);
			if (!p || !where || !p.fetch.hops.length) continue; // not fetched (guard or budget): listed under Not checked
			const reasons = reasonsOf(targetProblems(ctx, loc, p));
			if (reasons.length)
				out.push({ url: where.sitemap.fetch?.finalUrl ?? where.sitemap.url, locator: `line:${where.line}`, layer: "sitemap", observed: `${loc}: ${reasons.join("; ")}` });
		}
	return out;
}

export const rules: Record<string, Check> = {
	// canonical

	"CAN-001": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const raw = (p.raw?.signals.canonicals ?? []).filter((c) => c.region === "body");
			for (const c of raw) out.push({ url: p.fetch.finalUrl, locator: "html:body link[rel=canonical]", layer: "raw-html", observed: `canonical ${c.href} in <body> (line ${c.line})` });
			if (raw.length) continue;
			for (const c of (p.rendered?.signals.canonicals ?? []).filter((c) => c.region === "body"))
				out.push({ url: p.fetch.finalUrl, locator: "html:body link[rel=canonical]", layer: "rendered", observed: `canonical ${c.href} in <body> of the rendered DOM` });
		}
		return out;
	},

	"CAN-002": (ctx) =>
		ctx.audited.flatMap((p) =>
			declaredCanonicals(p)
				.filter((c) => c.href !== "" && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(c.href))
				.map((c) => ({ url: p.fetch.finalUrl, locator: CANONICAL_AT[c.source].locator, layer: CANONICAL_AT[c.source].layer, observed: `relative canonical href "${c.href}"` })),
		),

	"CAN-004": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			if (p.fetch.status !== 200) continue;
			const final = normaliseUrl(p.fetch.finalUrl);
			const redirected = redirectHops(p).length > 0;
			const listed = sitemapOf(ctx, normaliseUrl(p.url) ?? "") ?? (final ? sitemapOf(ctx, final) : null);
			const seen: Record<string, true> = {};
			for (const c of declaredCanonicals(p)) {
				if (!c.resolved || seen[c.source]) continue;
				const reasons: string[] = [];
				if (redirected && c.resolved !== final) reasons.push(`the redirect from ${p.url} delivered the page at ${p.fetch.finalUrl}`);
				if (listed) {
					if (normaliseUrl(listed.loc) !== c.resolved) reasons.push(`${listed.sitemap.url} line ${listed.line} lists ${listed.loc}`);
				}
				if (!reasons.length) continue;
				seen[c.source] = true;
				out.push({ url: p.fetch.finalUrl, locator: CANONICAL_AT[c.source].locator, layer: CANONICAL_AT[c.source].layer, observed: `canonical ${c.resolved}, but ${reasons.join(" and ")}` });
			}
		}
		return out;
	},

	"CAN-005": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const all = declaredCanonicals(p);
			const h = all.find((c) => c.source === "html");
			const l = all.find((c) => c.source === "header");
			if (h && l && h.resolved !== l.resolved)
				out.push({ url: p.fetch.finalUrl, locator: "header:link", layer: "headers", observed: `Link header canonical ${l.href}; HTML canonical ${h.href}` });
		}
		return out;
	},

	"CAN-006": (ctx) =>
		ctx.audited.flatMap((p) => {
			const html_ = (p.raw?.signals.canonicals ?? []).filter((c) => c.href.includes("#")).map((c) => ({ href: c.href, source: "html" as const }));
			const header = parseLinkHeader(p.fetch.headers.link)
				.filter((l) => l.params.rel?.split(/\s+/).includes("canonical") && l.href.includes("#"))
				.map((l) => ({ href: l.href, source: "header" as const }));
			return [...html_, ...header].map((c) => ({ url: p.fetch.finalUrl, locator: CANONICAL_AT[c.source].locator, layer: CANONICAL_AT[c.source].layer, observed: `canonical href "${c.href}" has a fragment` }));
		}),

	"CAN-007": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			if (!p.raw || !p.rendered) continue;
			const raw = p.raw.signals.canonicals.filter((x) => x.region === "head")[0];
			if (!raw) continue;
			const rendered = p.rendered.signals.canonicals.filter((x) => x.region === "head")[0];
			const rawUrl = normaliseUrl(raw.href, p.fetch.finalUrl);
			const renderedUrl = rendered ? normaliseUrl(rendered.href, p.rendered.page.finalUrl) : null;
			if (!rendered)
				out.push({ url: p.fetch.finalUrl, locator: "html:link[rel=canonical]", layer: "rendered", observed: `raw canonical ${raw.href} is absent from the rendered DOM` });
			else if (rawUrl !== renderedUrl)
				out.push({ url: p.fetch.finalUrl, locator: "html:link[rel=canonical]", layer: "rendered", observed: `raw canonical ${raw.href}; rendered canonical ${rendered.href}` });
		}
		return out;
	},

	"CAN-008": (ctx) =>
		ctx.audited.flatMap((p) =>
			(p.raw?.signals.canonicals ?? []).flatMap((c) => {
				const extra = CANONICAL_EXTRA_ATTRS.filter((a) => c.attrs[a] !== undefined);
				return extra.length
					? [{ url: p.fetch.finalUrl, locator: "html:link[rel=canonical]", layer: "raw-html" as const, observed: `canonical ${c.href} carries ${extra.map((a) => `${a}="${c.attrs[a]}"`).join(", ")}` }]
					: [];
			}),
		),

	"CAN-011": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			if (!p.rendered) continue;
			const canonical = declaredCanonicals(p).find((c) => c.resolved)?.resolved;
			if (!canonical) continue;
			const cu = new URL(canonical);
			const bare = (h: string) => h.replace(/^www\./, "");
			const chainHosts: Record<string, true> = {};
			for (const h of p.fetch.hops) chainHosts[new URL(h.url).host] = true;
			const offending: Record<string, string> = {};
			for (const a of p.rendered.signals.anchors) {
				if (!a.href) continue;
				const target = normaliseUrl(a.href, p.rendered.page.finalUrl);
				if (!target) continue;
				const tu = new URL(target);
				const internal = bare(tu.host) === bare(cu.host) || chainHosts[tu.host];
				if (internal && tu.origin !== cu.origin) offending[tu.origin] ??= a.href;
			}
			for (const [origin, href] of Object.entries(offending))
				out.push({ url: p.fetch.finalUrl, locator: `html:a[href^="${origin}"]`, layer: "rendered", observed: `link ${href} uses ${origin}; the canonical is on ${cu.origin}` });
		}
		return out;
	},

	"CAN-014": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const scan = p.raw?.signals.headScan;
			if (!scan?.invalid) continue;
			const ignored = scan.ignoredAfterInvalid.map((t) => `<${t.tag}> line ${t.line}`);
			out.push({
				url: p.fetch.finalUrl,
				locator: `html:head > ${scan.invalid.tag}`,
				layer: "raw-html",
				observed: `<${scan.invalid.tag}> at line ${scan.invalid.line} ends <head>; ignored after it: ${ignored.length ? ignored.join(", ") : "nothing"}`,
			});
		}
		return out;
	},

	"CAN-017": (ctx) =>
		ctx.audited.flatMap((p) =>
			redirectHops(p).flatMap((h) => {
				const from = new URL(h.from);
				const to = new URL(h.to);
				const samePath = `${from.pathname}${from.search}` === `${to.pathname}${to.search}`;
				if (!TEMPORARY[h.status] || !samePath || from.origin === to.origin) return [];
				return [{ url: p.url, locator: `hop:${h.n}`, layer: "headers" as const, observed: `${h.status} ${h.from} -> ${h.to} changes only scheme or host` }];
			}),
		),

	"HEU-02": (ctx) => heuristicCanonicalHits(ctx, true),

	"HEU-02b": (ctx) => heuristicCanonicalHits(ctx, false),

	"HEU-04": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const raw = p.raw?.signals.canonicals ?? [];
			const rendered = p.rendered?.signals.canonicals ?? [];
			if (raw.length > 1)
				out.push({ url: p.fetch.finalUrl, locator: "html:link[rel=canonical]", layer: "raw-html", observed: `${raw.length} canonical links: ${raw.map((c) => c.href).join(", ")}` });
			else if (rendered.length > 1)
				out.push({ url: p.fetch.finalUrl, locator: "html:link[rel=canonical]", layer: "rendered", observed: `${rendered.length} canonical links in the rendered DOM: ${rendered.map((c) => c.href).join(", ")}` });
		}
		return out;
	},

	// indexing

	"IDX-001": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const raw = rawDirectives(p);
			const meta = hasDirective(raw.filter((d) => d.source === "meta"), "noindex");
			const header = hasDirective(raw.filter((d) => d.source === "header"), "noindex");
			const rendered = hasDirective(googleDirectives(p.rendered?.directives ?? []), "noindex");
			const d = meta ?? header ?? rendered;
			if (!d) continue;
			const layer: Layer = meta ? "raw-html" : header ? "headers" : "rendered";
			out.push({ url: p.fetch.finalUrl, locator: d.locator, layer, observed: `${d.raw}${layer === "rendered" ? " (rendered DOM only)" : ""}` });
		}
		return out;
	},

	"IDX-002": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const block = pageRobotsBlock(ctx.evidence.sites, p, ["Googlebot"]);
			if (!block) continue;
			const ds = rawDirectives(p);
			const d = hasDirective(ds, "noindex") ?? ds[0];
			if (!d) continue;
			const rule = block.verdict.rule;
			out.push({
				url: p.fetch.finalUrl,
				locator: d.locator,
				layer: DIRECTIVE_LAYER[d.source],
				observed: `${d.raw}, but robots.txt line ${rule?.line ?? "?"} (${rule ? `Disallow: ${rule.path}` : "disallow"}) keeps Googlebot from reading it${redirectNote(p, block)}`,
			});
		}
		return out;
	},

	"IDX-003": (ctx) =>
		ctx.evidence.sites.flatMap((s) =>
			(s.robots.state === "ok" ? (s.robots.parsed?.noindexLines ?? []) : []).map((l) => ({
				url: s.robots.fetch.finalUrl,
				locator: `line:${l.line}`,
				layer: "robots" as const,
				observed: l.raw.trim(),
			})),
		),

	"IDX-007": (ctx) => [
		...directiveHits(ctx, "nosnippet", (d) => (d.name === "nosnippet" ? d.raw : null)),
		...directiveHits(ctx, "max-snippet", (d) => (d.name === "max-snippet" ? d.raw : null)),
	],

	"IDX-008": (ctx) =>
		directiveHits(ctx, "unavailable_after", (d) => {
			const at = Date.parse(d.value ?? "");
			return Number.isFinite(at) && at < ctx.auditTime.getTime() ? `unavailable_after ${d.value} is before the audit time ${ctx.evidence.auditTime}` : null;
		}),

	"IDX-009": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			if (!p.raw || !p.rendered) continue;
			const raw: Record<string, true> = {};
			const rendered: Record<string, true> = {};
			for (const n of p.raw.signals.nosnippet) raw[n.key] = true;
			for (const n of p.rendered.signals.nosnippet) rendered[n.key] = true;
			for (const k of Object.keys(raw))
				if (!rendered[k]) out.push({ url: p.fetch.finalUrl, locator: `html:${k}`, layer: "rendered", observed: `data-nosnippet on ${k} in raw HTML, absent from the rendered DOM` });
			for (const k of Object.keys(rendered))
				if (!raw[k]) out.push({ url: p.fetch.finalUrl, locator: `html:${k}`, layer: "rendered", observed: `data-nosnippet on ${k} in the rendered DOM only` });
		}
		return out;
	},

	"IDX-011": (ctx) => directiveHits(ctx, "nofollow", (d) => d.raw),

	"IDX-013": (ctx) => directiveHits(ctx, "noimageindex", (d) => d.raw),

	"IDX-014": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const ds = rawDirectives(p);
			for (const d of ds) {
				if (d.name !== "indexifembedded") continue;
				if (hasDirective(ds.filter((x) => x.scope === d.scope), "noindex")) continue;
				out.push({ url: p.fetch.finalUrl, locator: d.locator, layer: DIRECTIVE_LAYER[d.source], observed: `${d.raw} (no noindex for ${d.scope === "*" ? "all crawlers" : d.scope})` });
				break;
			}
		}
		return out;
	},

	"AI-033": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const raw = (p.raw?.signals.nosnippet ?? []).filter((n) => !NOSNIPPET_ELEMENTS[n.tag]);
			for (const n of raw) out.push({ url: p.fetch.finalUrl, locator: `html:${n.key}`, layer: "raw-html", observed: `data-nosnippet on <${n.tag}>` });
			const rawKeys: Record<string, true> = {};
			for (const n of raw) rawKeys[n.key] = true;
			for (const n of p.rendered?.signals.nosnippet ?? [])
				if (!NOSNIPPET_ELEMENTS[n.tag] && !rawKeys[n.key]) out.push({ url: p.fetch.finalUrl, locator: `html:${n.key}`, layer: "rendered", observed: `data-nosnippet on <${n.tag}> in the rendered DOM` });
		}
		return out;
	},

	// robots

	"RBT-002": (ctx) =>
		ctx.evidence.sites
			.filter((s) => s.robots.state === "unreachable")
			.map((s) => ({ url: s.robots.url, locator: "doc", layer: "robots" as const, observed: `${s.robots.url} answered ${s.robots.fetch.status}` })),

	"RBT-004": (ctx) =>
		ctx.evidence.sites.flatMap((s) => {
			const hops = s.robots.fetch.hops.filter((h) => REDIRECT[h.status] && h.location).length;
			return hops > 5 ? [{ url: s.robots.url, locator: "doc", layer: "headers" as const, observed: `robots.txt needed ${hops} redirects (final ${s.robots.fetch.finalUrl})` }] : [];
		}),

	"RBT-005": (ctx) =>
		ctx.evidence.sites.flatMap((s) =>
			s.robots.state === "ok" && s.robots.fetch.bytes > 512_000
				? [{ url: s.robots.fetch.finalUrl, locator: "doc", layer: "robots" as const, observed: `robots.txt is ${s.robots.fetch.bytes} bytes` }]
				: [],
		),

	"RBT-006": (ctx) =>
		ctx.evidence.sites.flatMap((s) => {
			if (s.robots.state !== "ok") return [];
			const ct = s.robots.fetch.headers["content-type"] ?? "";
			const out: Hit[] = [];
			if (!/^\s*text\/plain\s*(;|$)/i.test(ct))
				out.push({ url: s.robots.fetch.finalUrl, locator: "header:content-type", layer: "headers", observed: `Content-Type: ${ct || "(none)"}` });
			if (/^\s*(<!doctype html|<html)/i.test(s.robots.fetch.body ?? ""))
				out.push({ url: s.robots.fetch.finalUrl, locator: "doc", layer: "robots", observed: `body is an HTML document: ${(s.robots.fetch.body ?? "").trimStart().slice(0, 60)}` });
			return out;
		}),

	"RBT-008": (ctx) =>
		ctx.evidence.sites.flatMap((s) =>
			(s.robots.state === "ok" ? (s.robots.parsed?.invalidPaths ?? []) : []).map((l) => ({
				url: s.robots.fetch.finalUrl,
				locator: `line:${l.line}`,
				layer: "robots" as const,
				observed: l.raw.trim(),
			})),
		),

	"RBT-009": (ctx) =>
		ctx.evidence.sites.flatMap((s) =>
			(s.robots.state === "ok" ? (s.robots.parsed?.orphanRules ?? []) : []).map((l) => ({
				url: s.robots.fetch.finalUrl,
				locator: `line:${l.line}`,
				layer: "robots" as const,
				observed: `${l.raw.trim()} (before the first user-agent line)`,
			})),
		),

	"RBT-011": (ctx) =>
		ctx.evidence.sites.flatMap((s) =>
			(s.robots.state === "ok" ? (s.robots.parsed?.sitemaps ?? []) : [])
				.filter((m) => !isAbsoluteHttpUrl(m.value))
				.map((m) => ({ url: s.robots.fetch.finalUrl, locator: `line:${m.line}`, layer: "robots" as const, observed: `Sitemap: ${m.value}` })),
		),

	"RBT-012": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			const block = pageRobotsBlock(ctx.evidence.sites, p, ["Googlebot"]);
			if (!block) continue;
			const v = block.verdict;
			out.push({
				url: p.url,
				locator: `robots.txt:line:${v.rule?.line ?? 0}`,
				layer: "robots",
				observed: `Disallow: ${v.rule?.path ?? "?"} in the ${v.group ?? "?"} group matches ${pathOf(block.url)}${redirectNote(p, block)}`,
			});
		}
		return out;
	},

	"RBT-014": (ctx) => {
		const out: Hit[] = [];
		for (const p of ctx.audited) {
			if (!p.rendered) continue;
			const origin = new URL(p.rendered.page.finalUrl).origin;
			const seen: Record<string, true> = {};
			for (const r of p.rendered.page.requests) {
				let u: URL;
				try {
					u = new URL(r.url);
				} catch {
					continue;
				}
				if (u.origin !== origin || r.type === "Document" || seen[u.href]) continue;
				seen[u.href] = true;
				if (ctx.robotsAllowed(u.href) === false)
					out.push({ url: p.fetch.finalUrl, locator: `url:${u.pathname}${u.search}`, layer: "rendered", observed: `${r.type || "resource"} ${u.pathname}${u.search} is disallowed for Googlebot` });
			}
		}
		return out;
	},

	// sitemap

	"SMP-001": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) => {
			if (s.parsed?.type !== "urlset" && s.parsed?.type !== "text") return [];
			const count = s.parsed.type === "urlset" ? s.parsed.urls.length : s.parsed.textLines.length;
			const bytes = s.fetch?.bytes ?? 0;
			if (count <= SITEMAP_MAX_URLS && bytes <= SITEMAP_MAX_BYTES) return [];
			return [{ url: s.fetch?.finalUrl ?? s.url, locator: "doc", layer: "sitemap" as const, observed: `${count} URLs, ${bytes} bytes` }];
		}),

	"SMP-002": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) => {
			if (s.parsed?.type !== "sitemapindex") return [];
			const count = s.parsed.sitemaps.length;
			const bytes = s.fetch?.bytes ?? 0;
			if (count <= SITEMAP_MAX_URLS && bytes <= SITEMAP_MAX_BYTES) return [];
			return [{ url: s.fetch?.finalUrl ?? s.url, locator: "doc", layer: "sitemap" as const, observed: `${count} sitemaps, ${bytes} bytes` }];
		}),

	"SMP-003": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) => {
			const url = s.fetch?.finalUrl ?? s.url;
			const parsed = s.parsed;
			if (!parsed) return [];
			if (parsed.error) return [{ url, locator: `line:${parsed.error.line}`, layer: "sitemap" as const, observed: `XML error: ${parsed.error.message}` }];
			const out: Hit[] = [];
			for (const e of [...parsed.urls.map((u) => ({ loc: u.loc, line: u.locLine })), ...parsed.sitemaps.map((m) => ({ loc: m.loc, line: m.line }))]) {
				if (e.loc === null) continue;
				if (!isAbsoluteHttpUrl(e.loc)) out.push({ url, locator: `line:${e.line}`, layer: "sitemap", observed: `relative <loc>${e.loc}</loc>`, cause: "relative" });
				else if (e.loc.length >= 2048) out.push({ url, locator: `line:${e.line}`, layer: "sitemap", observed: `<loc> of ${e.loc.length} characters`, cause: "too long" });
			}
			return out;
		}),

	"SMP-004": (ctx) =>
		sampleHits(ctx, (p) => {
			const reasons: string[] = [];
			if (p.status !== null && REDIRECT[p.status]) reasons.push(`redirects (${p.status})`);
			else if (p.status !== null) reasons.push(`answers ${p.status}`);
			if (p.noindex) reasons.push("noindex");
			if (p.disallowed) reasons.push("disallowed for Googlebot");
			if (p.canonical) reasons.push(`canonical to ${p.canonical}`);
			return reasons;
		}),

	"SMP-005": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) =>
			(s.parsed?.urls ?? []).flatMap((u) => {
				if (u.lastmod === null) return [];
				const bad = !W3C_DATETIME.test(u.lastmod) ? "not W3C Datetime" : Date.parse(u.lastmod) > ctx.auditTime.getTime() ? "after the audit time" : null;
				return bad ? [{ url: s.fetch?.finalUrl ?? s.url, locator: `line:${u.lastmodLine}`, layer: "sitemap" as const, observed: `<lastmod>${u.lastmod}</lastmod> is ${bad}`, cause: bad === "not W3C Datetime" ? `${bad} ${lastmodForm(u.lastmod)}` : bad }] : [];
			}),
		),

	"SMP-007": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) => {
			const url = s.fetch?.finalUrl ?? s.url;
			const host = new URL(url).host;
			return (s.parsed?.urls ?? []).flatMap((u) => {
				if (!u.loc || !isAbsoluteHttpUrl(u.loc) || !normaliseUrl(u.loc)) return [];
				const other = new URL(u.loc).host;
				return other !== host ? [{ url, locator: `line:${u.locLine}`, layer: "sitemap" as const, observed: `<loc>${u.loc}</loc> is not on ${host}`, cause: other }] : [];
			});
		}),

	"SMP-010": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) => {
			const url = s.fetch?.finalUrl ?? s.url;
			const out: Hit[] = [];
			for (const u of s.parsed?.urls ?? []) {
				for (const img of u.images)
					if (img.loc === null) out.push({ url, locator: `line:${img.line}`, layer: "sitemap", observed: `<image:image> without <image:loc> in ${u.loc ?? "a <url>"}`, cause: "no image loc" });
				if (u.images.length > 1000) out.push({ url, locator: `line:${u.line}`, layer: "sitemap", observed: `${u.images.length} <image:image> in one <url>`, cause: "over 1000 images" });
			}
			return out;
		}),

	"SMP-011": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) =>
			s.parsed?.type === "text"
				? s.parsed.textLines
						.filter((l) => !isAbsoluteHttpUrl(l.value) || normaliseUrl(l.value) === null)
						.map((l) => ({ url: s.fetch?.finalUrl ?? s.url, locator: `line:${l.line}`, layer: "sitemap" as const, observed: `"${l.value}" is not an absolute URL`, cause: "not absolute" }))
				: [],
		),

	"SMP-012": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) => {
			const url = s.fetch?.finalUrl ?? s.url;
			const host = new URL(url).host;
			return (s.parsed?.sitemaps ?? []).flatMap((m) => {
				if (!m.loc || !isAbsoluteHttpUrl(m.loc) || !normaliseUrl(m.loc)) return [];
				const other = new URL(m.loc).host;
				return other !== host ? [{ url, locator: `line:${m.line}`, layer: "sitemap" as const, observed: `<loc>${m.loc}</loc> is not on ${host}`, cause: other }] : [];
			});
		}),

	"SMP-013": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) =>
			(s.parsed?.sitemaps ?? []).flatMap((m) =>
				m.lastmod !== null && !W3C_DATETIME.test(m.lastmod)
					? [{ url: s.fetch?.finalUrl ?? s.url, locator: `line:${m.lastmodLine}`, layer: "sitemap" as const, observed: `<lastmod>${m.lastmod}</lastmod> is not W3C Datetime`, cause: `not W3C Datetime ${lastmodForm(m.lastmod)}` }]
					: [],
			),
		),

	"SMP-014": (ctx) => {
		const https: Record<string, true> = {};
		for (const p of ctx.audited) if (p.url.startsWith("https:")) https[new URL(p.url).origin] = true;
		return ctx.evidence.sites
			.filter((site) => https[site.origin])
			.flatMap((site) => site.sitemaps.filter((m) => m.fetch?.status === 200))
			.flatMap((s) =>
				(s.parsed?.urls ?? []).flatMap((u) =>
					u.loc && /^http:\/\//i.test(u.loc)
						? [{ url: s.fetch?.finalUrl ?? s.url, locator: `line:${u.locLine}`, layer: "sitemap" as const, observed: `<loc>${u.loc}</loc> uses http: on an HTTPS site`, cause: "http" }]
						: [],
				),
			);
	},

	"SMP-015": (ctx) =>
		ctx.evidence.sites.flatMap((site) =>
			site.sitemaps
				.filter((s) => s.via === "robots" && s.fetch && s.fetch.status !== null && s.fetch.status !== 200)
				.map((s) => ({
					url: site.robots.fetch.finalUrl,
					locator: `line:${s.robotsLine}`,
					layer: "sitemap" as const,
					observed: `Sitemap: ${s.url} answered ${s.fetch?.status}`,
				})),
		),

	"BNG-002": (ctx) =>
		sampleHits(ctx, (p) => {
			const reasons: string[] = [];
			if (p.status !== null && REDIRECT[p.status]) reasons.push(`redirects (${p.status})`);
			else if (p.status !== null && p.status >= 400 && p.status < 500) reasons.push(`answers ${p.status}`);
			if (p.canonical) reasons.push(`canonical to ${p.canonical}`);
			return reasons;
		}),

	// http

	"HTTP-001": (ctx) =>
		ctx.audited.flatMap((p) => {
			const f = p.fetch;
			if (f.status === 200) return [];
			if (f.status === null && !f.loop && !f.tooManyRedirects) return []; // network failure, refusal or budget: the run is incomplete
			const what = f.status !== null ? `final status ${f.status} at ${f.finalUrl}` : f.loop ? "the redirect chain loops" : "the redirect chain never ends";
			return [{ url: p.url, locator: "doc", layer: "headers" as const, observed: what }];
		}),

	"HTTP-003": (ctx) =>
		ctx.audited.flatMap((p) => {
			const n = redirectHops(p).length;
			if (n <= 10 && !p.fetch.loop) return [];
			return [{ url: p.url, locator: "doc", layer: "headers" as const, observed: p.fetch.loop ? `redirect loop after ${n} hops` : `${n} redirect hops` }];
		}),

	"HTTP-003b": (ctx) =>
		ctx.audited.flatMap((p) => {
			const hops = redirectHops(p);
			if (hops.length < 2 || hops.length > 10 || p.fetch.loop) return [];
			return [{ url: p.url, locator: "doc", layer: "headers" as const, observed: `${hops.length} redirect hops: ${[p.url, ...hops.map((h) => h.to)].join(" -> ")}` }];
		}),

	"HTTP-004": (ctx) =>
		ctx.audited.flatMap((p) =>
			redirectHops(p).flatMap((h) => {
				const from = new URL(h.from);
				const to = new URL(h.to);
				return TEMPORARY[h.status] && from.pathname !== to.pathname
					? [{ url: p.url, locator: `hop:${h.n}`, layer: "headers" as const, observed: `${h.status} ${from.pathname} -> ${to.pathname}` }]
					: [];
			}),
		),

	"HTTP-005": (ctx) =>
		ctx.audited.flatMap((p) =>
			(p.raw?.signals.metas ?? [])
				.filter((m) => m.key === "http-equiv" && m.name === "refresh" && /url\s*=/i.test(m.content))
				.map((m) => ({ url: p.fetch.finalUrl, locator: "html:meta[http-equiv=refresh]", layer: "raw-html" as const, observed: `<meta http-equiv="refresh" content="${m.content}">` })),
		),

	"HTTP-006": (ctx) =>
		ctx.audited.flatMap((p) => {
			if (p.fetch.status !== 200 || !p.rendered) return [];
			const nav = p.rendered.page.navigations.find((n, i) => i > 0 && n.reason === "scriptInitiated");
			if (!nav) return [];
			const u = new URL(nav.url);
			return [{ url: p.fetch.finalUrl, locator: `url:${u.pathname}${u.search}`, layer: "rendered" as const, observed: `script navigated to ${nav.url}` }];
		}),
};

function heuristicCanonicalHits(ctx: RuleContext, problems: boolean): Hit[] {
	const out: Hit[] = [];
	for (const p of ctx.audited) {
		if (p.fetch.status !== 200) continue;
		const final = normaliseUrl(p.fetch.finalUrl);
		const seen: Record<string, true> = {};
		for (const c of declaredCanonicals(p)) {
			if (!c.resolved || c.resolved === final || seen[c.resolved]) continue;
			seen[c.resolved] = true;
			const target = ctx.page(c.resolved);
			if (!target || (target.fetch.status === null && !target.fetch.hops.length)) continue; // not fetched: Not checked
			const t = targetProblems(ctx, c.resolved, target);
			const reasons: string[] = [];
			if (t.status !== null && PERMANENT[t.status]) reasons.push(`redirects permanently (${t.status})`);
			else if (t.status !== null) reasons.push(`answers ${t.status}`);
			if (t.noindex) reasons.push("is noindex");
			if (t.disallowed) reasons.push("is disallowed for Googlebot");
			if (t.canonical) reasons.push(`declares canonical ${t.canonical}`);
			if (problems && reasons.length)
				out.push({ url: p.fetch.finalUrl, locator: CANONICAL_AT[c.source].locator, layer: CANONICAL_AT[c.source].layer, observed: `canonical ${c.resolved} ${reasons.join(", ")}` });
			if (!problems && !reasons.length)
				out.push({ url: p.fetch.finalUrl, locator: CANONICAL_AT[c.source].locator, layer: CANONICAL_AT[c.source].layer, observed: `canonical names ${c.resolved} (200, indexable, crawlable, self-canonical)` });
		}
	}
	return out;
}

export const notes: Record<string, Check> = {
	"DNF-07": (ctx) =>
		ctx.audited.flatMap((p) => {
			const d = (p.raw?.directives ?? []).find((x) => x.name === "nositelinkssearchbox" || x.name === "noarchive" || x.name === "nocache");
			return d ? [{ url: p.fetch.finalUrl, locator: d.locator, layer: DIRECTIVE_LAYER[d.source], observed: d.raw }] : [];
		}),

	"DNF-08": (ctx) =>
		fetchedSitemaps(ctx)
			.filter((s) => s.parsed?.type === "urlset")
			.map((s) => ({ url: s.fetch?.finalUrl ?? s.url, locator: "doc", layer: "sitemap" as const, observed: "priority and changefreq are not evaluated" })),

	"DNF-10": (ctx) =>
		ctx.audited.flatMap((p) =>
			p.fetch.status === 200 && p.raw && !declaredCanonicals(p).length && !(p.raw.signals.canonicals.length || p.rendered?.signals.canonicals.length)
				? [{ url: p.fetch.finalUrl, locator: "html:head", layer: "raw-html" as const, observed: "no canonical declared" }]
				: [],
		),

	"DNF-11": (ctx) =>
		ctx.evidence.sites.flatMap((site) => {
			const def = site.sitemaps.find((s) => s.via === "default");
			// Known to declare no sitemap: robots.txt answered 2xx without Sitemap lines, or 4xx (no robots.txt at all).
			const none = (site.robots.state === "ok" && !site.robots.parsed?.sitemaps.length) || site.robots.state === "unavailable";
			const status = def?.fetch?.status;
			return def && (status === 404 || status === 410) && none
				? [{ url: def.url, locator: "doc", layer: "sitemap" as const, observed: `/sitemap.xml answered ${status} and robots.txt declares no sitemap` }]
				: [];
		}),

	"DNF-16": (ctx) =>
		ctx.evidence.sites
			.filter((s) => s.robots.state === "unavailable")
			.map((s) => ({ url: s.robots.url, locator: "doc", layer: "robots" as const, observed: `robots.txt answered ${s.robots.fetch.status}` })),

	"DNF-25": (ctx) =>
		ctx.audited.flatMap((p) => {
			const n = p.raw?.signals.nosnippet[0];
			return n ? [{ url: p.fetch.finalUrl, locator: `html:${n.key}`, layer: "raw-html" as const, observed: `data-nosnippet="${n.value}"` }] : [];
		}),

	"NF-BNG-1": (ctx) =>
		fetchedSitemaps(ctx)
			.filter((s) => s.parsed?.type === "urlset" && s.parsed.urls.some((u) => u.priority === null || u.changefreq === null))
			.map((s) => ({ url: s.fetch?.finalUrl ?? s.url, locator: "doc", layer: "sitemap" as const, observed: "changefreq or priority missing" })),

	"NF-BNG-3": (ctx) =>
		fetchedSitemaps(ctx).flatMap((s) => {
			const counts: Record<string, number> = {};
			for (const u of s.parsed?.urls ?? []) if (u.lastmod) counts[u.lastmod] = (counts[u.lastmod] ?? 0) + 1;
			const today = ctx.evidence.auditTime.slice(0, 10);
			const repeated = Object.entries(counts).find(([v, n]) => n >= 2 && v.slice(0, 10) !== today);
			return repeated ? [{ url: s.fetch?.finalUrl ?? s.url, locator: "doc", layer: "sitemap" as const, observed: `${repeated[1]} URLs share <lastmod>${repeated[0]}</lastmod>` }] : [];
		}),
};
