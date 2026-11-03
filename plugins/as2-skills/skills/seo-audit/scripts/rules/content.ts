// Content family: the rules.md categories title, snippet, headings, images, links, mobile, international, site,
// javascript and page-experience, plus the do-not-flag notes that sit on the same evidence (DNF-01 to DNF-06, DNF-12,
// DNF-17, HEU-06). Every check reads Evidence only (see scripts/rules/README.md). Element locators come from
// lib/content-dom.ts, which numbers elements the same way in the raw HTML and the rendered DOM.
import type { Layer } from "../lib/catalogue.ts";
import { type Dom, type DomTag, domOf } from "../lib/content-dom.ts";
import { hreflangProblem } from "../lib/content-iso.ts";
import { googleDirectives, hasDirective } from "../lib/directives.ts";
import type { Check, Hit, RuleContext } from "../lib/engine.ts";
import type { PageEvidence } from "../lib/evidence.ts";
import { robotsVerdict } from "../lib/robots.ts";
import type { UaProbe } from "../lib/uaprobe.ts";
import { isAbsoluteHttpUrl, normaliseUrl, parseLinkHeader, pathOf } from "../lib/url.ts";

const REDIRECT: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
// IMG-004: the formats Google Search supports.
const IMAGE_FORMATS: Record<string, true> = { bmp: true, gif: true, jpg: true, jpeg: true, png: true, webp: true, svg: true, avif: true };
// LNK-001: attributes that make an <a> without href act as a link (a click handler or a client router).
const CLICK_ATTRS = ["onclick", "ng-click", "(click)", "@click", "v-on:click", "routerlink", "ng-href", "data-href", "data-url", "data-link", "to"];
// LNK-001: elements that take `href` and are not navigational links (HTML link-like elements and SVG references).
const HREF_NOT_A_LINK: Record<string, true> = {
	a: true,
	link: true,
	area: true,
	base: true,
	use: true,
	image: true,
	feimage: true,
	textpath: true,
	mpath: true,
	pattern: true,
	lineargradient: true,
	radialgradient: true,
	filter: true,
};
const FAVICON_RELS: Record<string, true> = { icon: true, "apple-touch-icon": true, "apple-touch-icon-precomposed": true };
const IMAGE_ROBOTS_TOKENS = ["Googlebot-Image", "Googlebot"];
// Do-not-flag thresholds: the limits popular audit tools apply (references/research/survey.md: "Title too long: > 60
// characters", description "Too long: > 160 characters", "< 300 words"). The notes fire where such a tool would flag,
// to say the skill deliberately does not.
const MYTH_TITLE_MAX = 60;
const MYTH_DESCRIPTION_MAX = 160;
const MYTH_MIN_WORDS = 300;

// Audited pages whose final response is a 200 HTML document: the pages the page-content rules read.
function htmlPages(ctx: RuleContext): (PageEvidence & { raw: NonNullable<PageEvidence["raw"]> })[] {
	return ctx.audited.filter((p): p is PageEvidence & { raw: NonNullable<PageEvidence["raw"]> } => p.fetch.status === 200 && p.raw !== null);
}

function headTitle(p: PageEvidence, layer: "raw" | "rendered"): string | null {
	return p[layer]?.signals.titles.find((t) => t.region === "head")?.text ?? null;
}

function metaContent(p: PageEvidence, name: string): { content: string; line: number } | null {
	const m = p.raw?.signals.metas.find((x) => x.key === "name" && x.name === name && x.region === "head");
	return m ? { content: m.content.replace(/\s+/g, " ").trim(), line: m.line } : null;
}

// An attribute-order-independent identity for an element, so a defect in both layers is reported once (raw-html).
function elementKey(t: DomTag): string {
	return `${t.name}|${JSON.stringify(Object.entries(t.attrs).sort(([a], [b]) => a.localeCompare(b)))}`;
}

// Runs `find` on the raw HTML and the rendered DOM: raw defects are `raw-html`; rendered defects are reported as
// `rendered` only when the same element is not already a raw defect.
function bothLayers(ctx: RuleContext, find: (dom: Dom) => { tag: DomTag; observed: string }[]): Hit[] {
	const out: Hit[] = [];
	for (const p of htmlPages(ctx)) {
		const raw = find(domOf(p.raw.html));
		const seen: Record<string, true> = {};
		for (const d of raw) {
			seen[elementKey(d.tag)] = true;
			out.push({ url: p.fetch.finalUrl, locator: `html:${d.tag.name}:nth(${d.tag.nth})`, layer: "raw-html", observed: `${d.observed} (line ${d.tag.line})` });
		}
		if (!p.rendered) continue;
		for (const d of find(domOf(p.rendered.html)))
			if (!seen[elementKey(d.tag)])
				out.push({ url: p.fetch.finalUrl, locator: `html:${d.tag.name}:nth(${d.tag.nth})`, layer: "rendered", observed: `${d.observed} (rendered DOM only)` });
	}
	return out;
}

// Anchors of the rendered DOM, with the page URL they resolve against.
function renderedAnchorHits(ctx: RuleContext, test: (a: Dom["anchors"][number], base: string) => string | null): Hit[] {
	const out: Hit[] = [];
	for (const p of htmlPages(ctx)) {
		if (!p.rendered) continue;
		const base = p.rendered.page.finalUrl;
		for (const a of domOf(p.rendered.html).anchors) {
			const observed = test(a, base);
			if (observed !== null) out.push({ url: p.fetch.finalUrl, locator: `html:a:nth(${a.tag.nth})`, layer: "rendered", observed });
		}
	}
	return out;
}

function tryUrl(href: string, base: string): URL | null {
	try {
		return new URL(href, base);
	} catch {
		return null;
	}
}

// Pages fetched in the run (audited and sitemap sample) with a 200 HTML response, one per final URL.
function fetchedHtmlPages(ctx: RuleContext): PageEvidence[] {
	const byUrl: Record<string, PageEvidence> = {};
	for (const p of ctx.evidence.pages) {
		if ((p.role !== "audited" && p.role !== "sample") || p.fetch.status !== 200 || !p.raw) continue;
		const k = normaliseUrl(p.fetch.finalUrl);
		if (k && !byUrl[k]) byUrl[k] = p;
	}
	return Object.values(byUrl);
}

// TTL-004 and SNP-002: a hit on every fetched page whose value another fetched page shares.
function duplicates(ctx: RuleContext, value: (p: PageEvidence) => string | null, locator: string, what: string): Hit[] {
	const groups: Record<string, PageEvidence[]> = {};
	for (const p of fetchedHtmlPages(ctx)) {
		const v = value(p);
		if (v) (groups[v] ??= []).push(p);
	}
	const out: Hit[] = [];
	for (const [v, ps] of Object.entries(groups)) {
		if (ps.length < 2) continue;
		for (const p of ps) {
			const others = ps.filter((o) => o !== p).map((o) => pathOf(o.fetch.finalUrl));
			out.push({ url: p.fetch.finalUrl, locator, layer: "site", observed: `${what} "${v}" is also on ${others.join(", ")}` });
		}
	}
	return out;
}

function isSiteRoot(p: PageEvidence): boolean {
	const u = tryUrl(p.url, p.url);
	return u !== null && u.pathname === "/" && u.search === "";
}

// The Googlebot smartphone and desktop UA probes of a page, when both got a response; with `sameStatus`, only when
// they got the same status, since a status difference is MOB-008's and makes the content comparison meaningless.
function probePair(p: PageEvidence, sameStatus: boolean): [UaProbe, UaProbe] | null {
	const m = p.uaProbes.find((u) => u.probe === "googlebot-smartphone");
	const d = p.uaProbes.find((u) => u.probe === "googlebot-desktop");
	if (!m || !d || m.status === null || d.status === null || (sameStatus && m.status !== d.status)) return null;
	return [m, d];
}

// A same-origin resource URL disallowed for Googlebot-Image (Googlebot when it has no group), as the robots-layer hit
// on `page` that points at the robots.txt line; null when it is allowed, cross-origin, or robots.txt is not usable.
function imageRobotsHit(ctx: RuleContext, page: PageEvidence, resource: string, what: string): Hit | null {
	const u = tryUrl(resource, page.fetch.finalUrl);
	if (!u || u.origin !== new URL(page.fetch.finalUrl).origin) return null;
	const parsed = ctx.site(u.href)?.robots.parsed;
	if (!parsed) return null;
	const v = robotsVerdict(parsed, IMAGE_ROBOTS_TOKENS, `${u.pathname}${u.search}`);
	if (v.allowed || !v.rule) return null;
	return {
		url: page.fetch.finalUrl,
		locator: `robots.txt:line:${v.rule.line}`,
		layer: "robots",
		observed: `${what}: ${u.pathname}${u.search} is disallowed for ${v.group ?? "*"} by robots.txt line ${v.rule.line}: Disallow: ${v.rule.path}`,
	};
}

// --- hreflang -----------------------------------------------------------------------------------------------------

interface Alternate {
	hreflang: string;
	href: string;
	resolved: string | null;
	layer: Layer;
	locator: string;
	url: string; // the resource the locator points into
	where: string; // for the observed text
}

function htmlAlternates(p: PageEvidence, region: "head" | "body" | "any"): Alternate[] {
	return (p.raw?.signals.links ?? [])
		.filter((l) => l.rel.split(/\s+/).includes("alternate") && l.attrs.hreflang !== undefined && (region === "any" || l.region === region))
		.map((l) => {
			const hreflang = l.attrs.hreflang ?? "";
			return {
				hreflang,
				href: l.href,
				resolved: normaliseUrl(l.href, p.fetch.finalUrl),
				layer: "raw-html",
				locator: l.region === "head" ? `html:link[hreflang=${hreflang}]` : `html:body link[hreflang=${hreflang}]`,
				url: p.fetch.finalUrl,
				where: `line ${l.line}`,
			};
		});
}

function headerAlternates(p: PageEvidence): Alternate[] {
	return parseLinkHeader(p.fetch.headers.link)
		.filter((l) => (l.params.rel ?? "").split(/\s+/).includes("alternate") && l.params.hreflang !== undefined)
		.map((l) => ({
			hreflang: l.params.hreflang ?? "",
			href: l.href,
			resolved: normaliseUrl(l.href, p.fetch.finalUrl),
			layer: "headers",
			locator: "header:link",
			url: p.fetch.finalUrl,
			where: "Link header",
		}));
}

// Every xhtml:link alternate of every fetched sitemap, with the <url> entry it belongs to.
function sitemapEntries(ctx: RuleContext): { sitemapUrl: string; loc: string | null; line: number; alternates: Alternate[] }[] {
	const out: { sitemapUrl: string; loc: string | null; line: number; alternates: Alternate[] }[] = [];
	for (const site of ctx.evidence.sites)
		for (const s of site.sitemaps) {
			if (!s.parsed || !s.fetch) continue;
			const sitemapUrl = s.fetch.finalUrl;
			for (const u of s.parsed.urls) {
				const alternates = u.alternates
					.filter((a) => a.rel.split(/\s+/).includes("alternate"))
					.map((a) => ({
						hreflang: a.hreflang,
						href: a.href,
						resolved: normaliseUrl(a.href, sitemapUrl),
						layer: "sitemap" as const,
						locator: `line:${a.line}`,
						url: sitemapUrl,
						where: `${pathOf(sitemapUrl)} line ${a.line}`,
					}));
				if (alternates.length) out.push({ sitemapUrl, loc: u.loc, line: u.line, alternates });
			}
		}
	return out;
}

// Every hreflang annotation the run saw: audited pages' HTML (head and body) and Link headers, and the sitemaps.
function allAlternates(ctx: RuleContext): Alternate[] {
	return [...htmlPages(ctx).flatMap((p) => [...htmlAlternates(p, "any"), ...headerAlternates(p)]), ...sitemapEntries(ctx).flatMap((e) => e.alternates)];
}

function ownUrls(p: PageEvidence): Record<string, true> {
	const out: Record<string, true> = {};
	for (const u of [p.url, p.fetch.finalUrl]) {
		const n = normaliseUrl(u);
		if (n) out[n] = true;
	}
	return out;
}

// `cause` collapses repeats only for sitemap alternates, the one source that can repeat a defect 50,000 times.
function alternateHit(a: Alternate, observed: string, cause?: string): Hit {
	return { url: a.url, locator: a.locator, layer: a.layer, observed: `${observed} (${a.where})`, ...(a.layer === "sitemap" && cause !== undefined ? { cause } : {}) };
}

// --- rules --------------------------------------------------------------------------------------------------------

export const rules: Record<string, Check> = {
	"TTL-001": (ctx) =>
		htmlPages(ctx)
			.filter((p) => !headTitle(p, "raw") && !(p.rendered && headTitle(p, "rendered")))
			.map((p) => {
				const titles = p.raw.signals.titles;
				const detail = titles.length ? `${titles.length} <title> element(s), none non-empty in <head>` : "no <title> element";
				return { url: p.fetch.finalUrl, locator: "html:head > title", layer: "raw-html", observed: `${detail} in the raw HTML${p.rendered ? " or the rendered DOM" : ""}` };
			}),

	"TTL-004": (ctx) => duplicates(ctx, (p) => headTitle(p, "raw"), "html:head > title", "title"),

	"TTL-005": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const t = headTitle(p, "raw");
			return t && /^[|\-–:]|[|\-–:]$/.test(t) ? [{ url: p.fetch.finalUrl, locator: "html:head > title", layer: "raw-html", observed: `title "${t}" starts or ends with a bare separator` }] : [];
		}),

	"HEU-04b": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const raw = domOf(p.raw.html).titles;
			if (raw.length > 1) {
				const second = raw[1];
				return [{ url: p.fetch.finalUrl, locator: "html:title:nth(2)", layer: "raw-html", observed: `${raw.length} <title> elements in the raw HTML (lines ${raw.map((t) => t.line).join(", ")})${second ? `; the second reads "${second.text.trim()}"` : ""}` }];
			}
			const rendered = p.rendered ? domOf(p.rendered.html).titles : [];
			return rendered.length > 1 ? [{ url: p.fetch.finalUrl, locator: "html:title:nth(2)", layer: "rendered", observed: `${rendered.length} <title> elements in the rendered DOM only` }] : [];
		}),

	"SNP-002": (ctx) => duplicates(ctx, (p) => metaContent(p, "description")?.content || null, "html:meta[name=description]", "meta description"),

	"JS-007": (ctx) =>
		renderedAnchorHits(ctx, (a, base) => {
			const href = a.tag.attrs.href;
			if (href === undefined) return null;
			const u = tryUrl(href, base);
			const page = tryUrl(base, base);
			if (!u || !page || !/^#[/!]/.test(u.hash)) return null;
			u.hash = "";
			page.hash = "";
			return u.href === page.href ? `link to fragment route ${href}` : null;
		}),

	"JS-009": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			if (!p.rendered) return [];
			// Only the meta tag: the rendered DOM cannot remove an X-Robots-Tag header, so a header noindex is IDX-001's alone.
			const raw = hasDirective(
				googleDirectives(p.raw.directives).filter((d) => d.source === "meta"),
				"noindex",
			);
			if (!raw || hasDirective(googleDirectives(p.rendered.directives), "noindex")) return [];
			return [{ url: p.fetch.finalUrl, locator: raw.locator, layer: "rendered", observed: `raw HTML has ${raw.locator.slice(5)} "${raw.raw}"; the rendered DOM has no noindex` }];
		}),

	"LNK-001": (ctx) =>
		bothLayers(ctx, (dom) => {
			const out: { tag: DomTag; observed: string }[] = [];
			for (const a of dom.anchors) {
				if (a.tag.attrs.href !== undefined) continue;
				const attr = CLICK_ATTRS.find((k) => a.tag.attrs[k] !== undefined);
				if (attr) out.push({ tag: a.tag, observed: `<a ${attr}="${a.tag.attrs[attr] ?? ""}"> without href, text "${a.text}"` });
			}
			for (const t of dom.tags)
				if (t.attrs.href !== undefined && !HREF_NOT_A_LINK[t.name]) out.push({ tag: t, observed: `<${t.name} href="${t.attrs.href}"> is not an <a> element` });
			return out;
		}),

	"LNK-002": (ctx) =>
		renderedAnchorHits(ctx, (a) => {
			const href = a.tag.attrs.href;
			if (href === undefined) return null;
			if (href.trim() === "") return `<a href=""> (empty), text "${a.text}"`;
			return /^\s*javascript:/i.test(href) ? `<a href="${href}">, text "${a.text}"` : null;
		}),

	"LNK-003": (ctx) =>
		renderedAnchorHits(ctx, (a) => {
			const at = a.tag.attrs;
			if (at.href === undefined || a.text || at["aria-label"]?.trim() || at.title?.trim() || a.imgAlts.some((alt) => alt?.trim())) return null;
			return `<a href="${at.href}"> has no text, aria-label, title or image alt`;
		}),

	"LNK-008b": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			if (!p.rendered) return [];
			const host = new URL(p.rendered.page.finalUrl).hostname;
			const external = domOf(p.rendered.html).anchors.filter((a) => {
				const u = a.tag.attrs.href === undefined ? null : tryUrl(a.tag.attrs.href, p.rendered?.page.finalUrl ?? p.fetch.finalUrl);
				return u !== null && /^https?:$/.test(u.protocol) && u.hostname !== host;
			});
			const nofollow = external.filter((a) => (a.tag.attrs.rel ?? "").toLowerCase().split(/\s+/).includes("nofollow"));
			return external.length >= 3 && nofollow.length === external.length
				? [{ url: p.fetch.finalUrl, locator: "html:a[rel~=nofollow]", layer: "rendered", observed: `all ${external.length} external links carry rel=nofollow` }]
				: [];
		}),

	"LNK-009": (ctx) =>
		htmlPages(ctx).flatMap((p) =>
			domOf(p.raw.html)
				.anchors.filter((a) => /[^\x00-\x7f]/.test(a.tag.attrs.href ?? ""))
				.map((a) => ({ url: p.fetch.finalUrl, locator: `html:a:nth(${a.tag.nth})`, layer: "raw-html", observed: `href "${a.tag.attrs.href ?? ""}" has non-ASCII characters (line ${a.tag.line})` })),
		),

	"LNK-012": (ctx) =>
		renderedAnchorHits(ctx, (a, base) => {
			const href = a.tag.attrs.href;
			const u = href === undefined ? null : tryUrl(href, base);
			if (!href || !u || u.origin !== new URL(base).origin) return null;
			const q = href.split("#")[0]?.split("?").slice(1).join("?") ?? "";
			if (!q) return null;
			const bad = q.split("&").filter((part) => part !== "" && !/^[^=;:]+=[^;]*$/.test(part));
			return bad.length ? `query "?${q}" is not key=value pairs joined by & ("${bad[0]}")` : null;
		}),

	"IMG-002": (ctx) => bothLayers(ctx, (dom) => dom.images.filter((i) => i.tag.attrs.alt === undefined).map((i) => ({ tag: i.tag, observed: `<img src="${i.tag.attrs.src ?? ""}"> has no alt attribute` }))),

	"IMG-003": (ctx) =>
		htmlPages(ctx).flatMap((p) =>
			domOf(p.raw.html)
				.images.filter((i) => (i.tag.attrs.srcset !== undefined || i.inPicture) && !i.tag.attrs.src?.trim())
				.map((i) => ({
					url: p.fetch.finalUrl,
					locator: `html:img:nth(${i.tag.nth})`,
					layer: "raw-html",
					observed: `<img${i.tag.attrs.srcset !== undefined ? ` srcset="${i.tag.attrs.srcset}"` : ""}>${i.inPicture ? " inside <picture>" : ""} has no src (line ${i.tag.line})`,
				})),
		),

	"IMG-004": (ctx) =>
		htmlPages(ctx).flatMap((p) =>
			domOf(p.raw.html).images.flatMap((i) => {
				const src = i.tag.attrs.src?.trim();
				const u = src && !/^data:/i.test(src) ? tryUrl(src, p.fetch.finalUrl) : null;
				const ext = u?.pathname.split("/").pop()?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
				return ext && !IMAGE_FORMATS[ext]
					? [{ url: p.fetch.finalUrl, locator: `html:img:nth(${i.tag.nth})`, layer: "raw-html" as const, observed: `<img src="${src}">: .${ext} is not a format Google Search supports (line ${i.tag.line})` }]
					: [];
			}),
		),

	"IMG-008": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const srcs = [...domOf(p.raw.html).images, ...(p.rendered ? domOf(p.rendered.html).images : [])].map((i) => i.tag.attrs.src?.trim() ?? "");
			return [...new Set(srcs)].flatMap((src) => {
				const hit = src ? imageRobotsHit(ctx, p, src, `<img src="${src}">`) : null;
				return hit ? [hit] : [];
			});
		}),

	"MOB-001": (ctx) =>
		htmlPages(ctx)
			.filter((p) => !metaContent(p, "viewport"))
			.map((p) => {
				const body = p.raw.signals.metas.find((m) => m.key === "name" && m.name === "viewport");
				return { url: p.fetch.finalUrl, locator: "html:head", layer: "raw-html", observed: body ? `meta viewport only outside <head> (line ${body.line})` : "no <meta name=viewport> in <head>" };
			}),

	"HEU-05": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const v = metaContent(p, "viewport");
			return v && !/(^|[,;\s])width\s*=\s*device-width\b/i.test(v.content)
				? [{ url: p.fetch.finalUrl, locator: "html:meta[name=viewport]", layer: "raw-html", observed: `viewport "${v.content}" has no width=device-width (line ${v.line})` }]
				: [];
		}),

	"MOB-003": (ctx) =>
		ctx.audited.flatMap((p) => {
			const pair = probePair(p, true);
			if (!pair) return [];
			const [m, d] = pair;
			const google = (rs: string[]) => rs.filter((r) => r.startsWith("*:") || r.startsWith("googlebot:")).map((r) => r.split(":")[1] ?? "");
			const mob = google(m.robots);
			const desk = google(d.robots);
			const extra = ["noindex", "nofollow"].filter((n) => (mob.includes(n) || mob.includes("none")) && !(desk.includes(n) || desk.includes("none")));
			return extra.length ? [{ url: p.url, locator: "ua:googlebot-smartphone", layer: "ua-probe", observed: `smartphone probe has ${extra.join(", ")} (${m.robots.join(", ")}); desktop probe has ${d.robots.join(", ") || "none"}` }] : [];
		}),

	"MOB-004": (ctx) =>
		ctx.audited.flatMap((p) => {
			const pair = probePair(p, true);
			if (!pair) return [];
			const [m, d] = pair;
			const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
			const diffs: string[] = [];
			if (norm(m.title) !== norm(d.title)) diffs.push(`title "${norm(m.title)}" vs "${norm(d.title)}"`);
			if (norm(m.description) !== norm(d.description)) diffs.push(`description "${norm(m.description)}" vs "${norm(d.description)}"`);
			return diffs.length ? [{ url: p.url, locator: "ua:googlebot-smartphone", layer: "ua-probe", observed: `smartphone vs desktop: ${diffs.join("; ")}` }] : [];
		}),

	"MOB-005": (ctx) =>
		ctx.audited.flatMap((p) => {
			const pair = probePair(p, true);
			if (!pair) return [];
			const [m, d] = pair;
			const heads = (hs: { level: number; text: string }[]) => hs.map((h) => `h${h.level} ${h.text}`).join(" | ");
			const diffs: string[] = [];
			if (heads(m.headings) !== heads(d.headings)) diffs.push(`headings [${heads(m.headings)}] vs [${heads(d.headings)}]`);
			if (JSON.stringify(m.imageAlts) !== JSON.stringify(d.imageAlts)) diffs.push(`image alts ${JSON.stringify(m.imageAlts)} vs ${JSON.stringify(d.imageAlts)}`);
			return diffs.length ? [{ url: p.url, locator: "ua:googlebot-smartphone", layer: "ua-probe", observed: `smartphone vs desktop: ${diffs.join("; ")}` }] : [];
		}),

	"MOB-008": (ctx) =>
		ctx.audited.flatMap((p) => {
			const pair = probePair(p, false);
			if (!pair || pair[0].status === pair[1].status) return [];
			const [m, d] = pair;
			return [{ url: p.url, locator: "ua:googlebot-smartphone", layer: "ua-probe", observed: `smartphone probe got ${m.status}; desktop probe got ${d.status}` }];
		}),

	"INT-001": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const alts = [...htmlAlternates(p, "head"), ...headerAlternates(p)];
			const own = ownUrls(p);
			if (!alts.length || alts.some((a) => a.resolved && own[a.resolved])) return [];
			const html = alts.some((a) => a.layer === "raw-html");
			return [
				{
					url: p.fetch.finalUrl,
					locator: html ? "html:link[rel=alternate][hreflang]" : "header:link",
					layer: html ? "raw-html" : "headers",
					observed: `hreflang alternates ${alts.map((a) => `${a.hreflang}=${a.href}`).join(", ")}; none is this page`,
				},
			];
		}),

	"INT-002": (ctx) => {
		const out: Hit[] = [];
		const pages = htmlPages(ctx);
		const seen: Record<string, true> = {};
		for (const a of pages)
			for (const alt of [...htmlAlternates(a, "head"), ...headerAlternates(a)]) {
				const b = pages.find((x) => x !== a && alt.resolved !== null && ownUrls(x)[alt.resolved]);
				if (!b) continue;
				const pair = `${a.fetch.finalUrl}\u0000${b.fetch.finalUrl}`;
				if (seen[pair]) continue;
				seen[pair] = true;
				const back = [...htmlAlternates(b, "head"), ...headerAlternates(b)];
				const aOwn = ownUrls(a);
				if (back.some((x) => x.resolved && aOwn[x.resolved])) continue;
				const html = back.some((x) => x.layer === "raw-html") || !back.length;
				out.push({
					url: b.fetch.finalUrl,
					locator: html ? "html:head" : "header:link",
					layer: html ? "raw-html" : "headers",
					observed: `${pathOf(a.fetch.finalUrl)} lists ${pathOf(b.fetch.finalUrl)} as hreflang ${alt.hreflang}; ${pathOf(b.fetch.finalUrl)} has no hreflang annotation back to ${pathOf(a.fetch.finalUrl)}`,
				});
			}
		return out;
	},

	"INT-003": (ctx) =>
		allAlternates(ctx).flatMap((a) => (isAbsoluteHttpUrl(a.href) ? [] : [alternateHit(a, `hreflang ${a.hreflang} href "${a.href}" is not fully qualified`, "not fully qualified")])),

	"INT-004": (ctx) =>
		allAlternates(ctx).flatMap((a) => {
			const problem = hreflangProblem(a.hreflang);
			return problem ? [alternateHit(a, `hreflang ${problem}`, problem)] : [];
		}),

	"INT-006": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const invalid = p.raw.signals.headScan.invalid;
			return htmlAlternates(p, "body").map((a) =>
				alternateHit(a, `hreflang ${a.hreflang} link ${invalid ? `after the invalid head element <${invalid.tag}> (line ${invalid.line}), so outside the head Google reads` : "in <body>"}`),
			);
		}),

	"INT-007": (ctx) => {
		const entries = sitemapEntries(ctx);
		return htmlPages(ctx).flatMap((p) => {
			const own = ownUrls(p);
			const methods: [string, Alternate[]][] = [
				["HTML", htmlAlternates(p, "head")],
				["Link header", headerAlternates(p)],
				["sitemap", entries.filter((e) => e.loc && own[normaliseUrl(e.loc) ?? ""]).flatMap((e) => e.alternates)],
			];
			const present = methods.filter(([, alts]) => alts.length);
			if (present.length < 2) return [];
			const sets = present.map(([name, alts]) => [name, [...new Set(alts.map((a) => a.resolved ?? a.href))].sort().join(" ")] as const);
			if (sets.every(([, s]) => s === sets[0]?.[1])) return [];
			const html = present.some(([name]) => name === "HTML");
			return [
				{
					url: p.fetch.finalUrl,
					locator: html ? "html:link[rel=alternate][hreflang]" : "header:link",
					layer: html ? "raw-html" : "headers",
					observed: sets.map(([name, s]) => `${name}: ${s.split(" ").map(pathOf).join(", ")}`).join("; "),
				},
			];
		});
	},

	"INT-011": (ctx) =>
		sitemapEntries(ctx).flatMap((e) => {
			const loc = e.loc ? normaliseUrl(e.loc) : null;
			if (!loc || e.alternates.some((a) => a.resolved === loc)) return [];
			return [{ url: e.sitemapUrl, locator: `line:${e.line}`, layer: "sitemap", observed: `<url> ${e.loc}: xhtml:link alternates ${e.alternates.map((a) => `${a.hreflang}=${a.href}`).join(", ")}; none is the <loc>`, cause: "no self alternate" }];
		}),

	"INT-012": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const alts = headerAlternates(p);
			const own = ownUrls(p);
			if (!alts.length || alts.some((a) => a.resolved && own[a.resolved])) return [];
			return [{ url: p.fetch.finalUrl, locator: "header:link", layer: "headers", observed: `Link header hreflang alternates ${alts.map((a) => `${a.hreflang}=${a.href}`).join(", ")}; none is the requested URL` }];
		}),

	"INT-014": (ctx) => {
		const https = htmlPages(ctx).filter((p) => p.fetch.finalUrl.startsWith("https:"));
		if (!https.length) return [];
		const sitemapAlts = sitemapEntries(ctx)
			.filter((e) => e.sitemapUrl.startsWith("https:"))
			.flatMap((e) => e.alternates);
		return [...https.flatMap((p) => [...htmlAlternates(p, "any"), ...headerAlternates(p)]), ...sitemapAlts]
			.filter((a) => /^http:/i.test(a.href.trim()))
			.map((a) => alternateHit(a, `hreflang ${a.hreflang} names the http: URL ${a.href} on an HTTPS site`, "http alternate"));
	},

	"PX-001": (ctx) =>
		ctx.audited
			.filter((p) => p.fetch.status !== null && p.fetch.finalUrl.startsWith("http:"))
			.map((p) => ({ url: p.fetch.finalUrl, locator: `url:${pathOf(p.fetch.finalUrl)}`, layer: "headers", observed: `final URL ${p.fetch.finalUrl} is served over http (status ${p.fetch.status})` })),

	"PX-002": (ctx) =>
		ctx.audited.flatMap((p) =>
			p.fetch.hops.flatMap((h, i) => {
				if (!REDIRECT[h.status] || !h.location || !h.url.startsWith("https:")) return [];
				const to = normaliseUrl(h.location, h.url);
				return to?.startsWith("http:") ? [{ url: p.url, locator: `hop:${i + 1}`, layer: "headers" as const, observed: `${h.status} from ${h.url} to ${to}` }] : [];
			}),
		),

	"PX-003": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			if (!p.rendered || !p.rendered.page.finalUrl.startsWith("https:")) return [];
			const insecure = p.rendered.page.requests.filter((r) => r.url.startsWith("http:") && r.type !== "Image");
			return insecure
				.filter((r, i) => insecure.findIndex((x) => x.url === r.url) === i)
				.map((r) => ({ url: p.fetch.finalUrl, locator: `url:${r.url}`, layer: "rendered" as const, observed: `${r.type || "request"} ${r.url} over http from an https page${r.failed ? ` (${r.failed})` : ""}` }));
		}),

	"SITE-001": (ctx) =>
		htmlPages(ctx)
			.filter((p) => isSiteRoot(p) && !favicons(p).length)
			.map((p) => ({ url: p.fetch.finalUrl, locator: "html:head", layer: "raw-html", observed: "no <link rel=icon|shortcut icon|apple-touch-icon> with an href in the home page <head>" })),

	"SITE-003": (ctx) =>
		htmlPages(ctx)
			.filter(isSiteRoot)
			.flatMap((p) =>
				favicons(p).flatMap((href) => {
					const hit = imageRobotsHit(ctx, p, href, `favicon ${href}`);
					return hit ? [hit] : [];
				}),
			),

	"SITE-005": (ctx) =>
		htmlPages(ctx)
			.filter(isSiteRoot)
			.flatMap((p) => {
				const nodes = [...p.raw.jsonld.nodes, ...(p.rendered?.jsonld.nodes ?? [])];
				const ok = nodes.some((n) => n.types.includes("WebSite") && typeof n.node.name === "string" && n.node.name.trim() && typeof n.node.url === "string" && n.node.url.trim());
				if (ok) return [];
				const sites = nodes.filter((n) => n.types.includes("WebSite"));
				return [
					{
						url: p.fetch.finalUrl,
						locator: p.raw.jsonld.blocks.length ? "html:script[type=application/ld+json]" : "html:head",
						layer: "structured-data" as const,
						observed: sites.length ? "WebSite node without both name and url" : `no WebSite node in ${p.raw.jsonld.blocks.length} JSON-LD block(s)`,
					},
				];
			}),
};

function favicons(p: PageEvidence): string[] {
	return (p.raw?.signals.links ?? [])
		.filter((l) => l.region === "head" && l.href.trim() && l.rel.split(/\s+/).some((r) => FAVICON_RELS[r]))
		.map((l) => l.href.trim());
}

// --- do-not-flag notes ----------------------------------------------------------------------------------------------

// Site-wide practices (meta keywords, lang and hreflang, pagination links, word count) are noted once per origin, on the
// first audited page that shows them, so a report on many pages does not repeat the same note.
function oncePerOrigin<P extends PageEvidence>(pages: P[]): P[] {
	const seen: Record<string, true> = {};
	return pages.filter((p) => {
		const origin = new URL(p.fetch.finalUrl).origin;
		if (seen[origin]) return false;
		seen[origin] = true;
		return true;
	});
}

function wordCount(p: PageEvidence): number {
	return (p.raw?.signals.mainText ?? "").split(/\s+/).filter(Boolean).length;
}

// DNF-05: what of `lang` and hreflang the page lacks.
function languageMyths(p: PageEvidence): string[] {
	const out: string[] = [];
	if (!p.raw?.signals.lang?.trim()) out.push("no lang attribute");
	if (!htmlAlternates(p, "any").length && !headerAlternates(p).length) out.push("no hreflang");
	return out;
}

function note(p: PageEvidence, locator: string, observed: string): Hit {
	return { url: p.fetch.finalUrl, locator, layer: "raw-html", observed };
}

export const notes: Record<string, Check> = {
	"DNF-01": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const t = headTitle(p, "raw");
			return t && t.length > MYTH_TITLE_MAX ? [note(p, "html:head > title", `title is ${t.length} characters; title length is not a defect`)] : [];
		}),

	"DNF-02": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const d = metaContent(p, "description");
			return d && d.content.length > MYTH_DESCRIPTION_MAX ? [note(p, "html:meta[name=description]", `meta description is ${d.content.length} characters; description length is not a defect`)] : [];
		}),

	"DNF-03": (ctx) =>
		htmlPages(ctx).flatMap((p) => {
			const hs = domOf(p.raw.html).headings;
			const out: Hit[] = [];
			const h1s = hs.filter((h) => h.level === 1);
			const second = h1s[1];
			if (second) out.push(note(p, `html:h1:nth(${second.tag.nth})`, `${h1s.length} h1 elements; heading count is not a defect`));
			const skip = hs.find((h, i) => i > 0 && h.level > (hs[i - 1]?.level ?? 0) + 1);
			if (skip) out.push(note(p, `html:${skip.tag.name}:nth(${skip.tag.nth})`, `h${hs[hs.indexOf(skip) - 1]?.level ?? 0} followed by h${skip.level}; heading order is not a defect`));
			return out;
		}),

	"DNF-04": (ctx) =>
		oncePerOrigin(htmlPages(ctx).filter((p) => !p.raw.signals.metas.some((m) => m.key === "name" && m.name === "keywords"))).map((p) =>
			note(p, "html:head", "no meta keywords; Google does not use it"),
		),

	"DNF-05": (ctx) =>
		oncePerOrigin(htmlPages(ctx).filter((p) => languageMyths(p).length)).map((p) =>
			note(p, "html:html", `${languageMyths(p).join(", ")}; Google detects the language from the text`),
		),

	"DNF-06": (ctx) =>
		oncePerOrigin(htmlPages(ctx).filter((p) => !p.raw.signals.links.some((l) => l.rel.split(/\s+/).some((r) => r === "next" || r === "prev")))).map((p) =>
			note(p, "html:head", "no rel=next/prev; Google no longer uses them"),
		),

	"DNF-12": (ctx) =>
		oncePerOrigin(htmlPages(ctx).filter((p) => wordCount(p) < MYTH_MIN_WORDS)).map((p) => note(p, "html:body", `${wordCount(p)} words of text; word count is not a defect`)),

	"DNF-17": (ctx) =>
		htmlPages(ctx).flatMap((p) =>
			domOf(p.raw.html)
				.tags.filter(
					(t) =>
						t.region === "body" &&
						((t.name === "details" && t.attrs.open === undefined) ||
							t.attrs.hidden !== undefined ||
							t.attrs.role === "tabpanel" ||
							/(^|\s)(sr-only|visually-hidden|screen-reader-text)(\s|$)/.test(t.attrs.class ?? "")),
				)
				.map((t) => note(p, `html:${t.name}:nth(${t.nth})`, `<${t.name}> collapsed or hidden content (accordion, tab or screen-reader text) at line ${t.line}; not hidden-text spam`)),
		),

	"HEU-06": (ctx) =>
		htmlPages(ctx).flatMap((p) =>
			domOf(p.raw.html)
				.images.filter((i) => i.tag.attrs.alt === "")
				.map((i) => note(p, `html:img:nth(${i.tag.nth})`, `<img src="${i.tag.attrs.src ?? ""}" alt=""> is a decorative image; an empty alt is correct`)),
		),
};
