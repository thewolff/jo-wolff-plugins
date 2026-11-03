// Evidence collection (plan section 3): the skill's own fetches (pages, robots.txt, sitemaps, llms.txt, canonical
// targets, the sitemap sample, UA probes), the rendered DOM, Lighthouse, CrUX and the source layer, gathered into one
// Evidence object that the rule modules read and evidence.json records. Order follows the budget's priorities: the
// audited pages, then robots and sitemaps, then canonical targets and the sample, then UA probes.
import { type CruxEvidence, loadCrux, noCrux, queryCrux } from "./crux.ts";
import { type RobotsDirective, robotsDirectives } from "./directives.ts";
import { type FetchResult, bodyError, fetchChain } from "./fetch.ts";
import { Budget, Guard, type Refusal } from "./guard.ts";
import { type HtmlSignals, extractSignals } from "./html.ts";
import { type JsonLdEvidence, extractJsonLd } from "./jsonld.ts";
import { type LighthouseEvidence, loadLhr, runLighthouse } from "./lighthouse.ts";
import { GuardProxy, type ProxyRunStats } from "./proxy.ts";
import { type RenderedPage, loadRecording, renderUrl, saveRecording } from "./render.ts";
import { writeContained } from "./report.ts";
import { type ParsedRobots, type RobotsRule, type RobotsVerdict, parseRobots, robotsVerdict } from "./robots.ts";
import { type ParsedSitemap, parseSitemap } from "./sitemap.ts";
import { type SourceEvidence, scanSource } from "./source.ts";
import { type UaProbe, probeUserAgents } from "./uaprobe.ts";
import { isAbsoluteHttpUrl, normaliseUrl, parseLinkHeader, pathOf } from "./url.ts";

export interface LayerEvidence {
	html: string;
	signals: HtmlSignals;
	jsonld: JsonLdEvidence;
	directives: RobotsDirective[];
}

export interface RenderedEvidence extends LayerEvidence {
	page: Omit<RenderedPage, "html">;
}

export interface PageEvidence {
	url: string; // as requested
	role: "audited" | "sample" | "canonical-target";
	fetch: FetchResult;
	raw: LayerEvidence | null; // null when the final response is not an HTML document
	rendered: RenderedEvidence | null;
	renderNote: string | null; // why there is no rendered layer
	uaProbes: UaProbe[];
	lighthouse: LighthouseEvidence | null;
	crux: CruxEvidence | null;
}

export interface RobotsEvidence {
	url: string;
	fetch: FetchResult;
	// 2xx / 4xx except 429 / 5xx or 429 / no response, or a 2xx whose body could not be read (no rules to apply)
	state: "ok" | "unavailable" | "unreachable" | "failed";
	parsed: ParsedRobots | null; // parsed only for state ok
	// One entry per token for every URL on this origin that a crawler fetches for an audited page (crawledUrls).
	verdicts: { url: string; token: string; allowed: boolean; group: string | null; rule: RobotsRule | null }[];
}

export interface SitemapEvidence {
	url: string;
	via: "robots" | "default" | "index";
	robotsLine: number | null;
	parent: string | null; // the sitemap index that listed it
	fetch: FetchResult | null; // null when not fetched (see skipped)
	skipped: string | null;
	parsed: ParsedSitemap | null; // parsed only for status 200
	childrenNotQueued: number; // index entries past the per-index fetch limit
}

export interface SiteEvidence {
	origin: string;
	// target: an audited URL's own origin. redirect: reached only by an audited URL's redirect, so only its robots.txt is
	// fetched (a crawler reads it before following the redirect); sitemaps and llms.txt stay empty.
	reachedBy: "target" | "redirect";
	robots: RobotsEvidence;
	sitemaps: SitemapEvidence[];
	llms: FetchResult | null;
	sample: string[]; // sitemap <loc> URLs chosen for the sample, in order
}

export interface Evidence {
	tool: "seo-audit";
	version: 1;
	auditTime: string;
	targets: string[];
	intentNoindex: string[];
	options: CollectOptionsRecord;
	pages: PageEvidence[];
	sites: SiteEvidence[];
	source: SourceEvidence | null;
	guard: { allowLocal: string[]; refusals: Refusal[]; budget: { max: number; used: number; exhausted: number }; proxyRuns: ProxyRunStats[] };
	notChecked: { item: string; reason: string }[];
	incomplete: string[];
}

export interface CollectOptions {
	targets: string[];
	intentNoindex: string[];
	allowLocal: string[];
	budget: number;
	sample: number;
	render: { mode: "off" | "chrome" | "recorded"; from: string | null; recordTo: string | null };
	lighthouse: { mode: "off" | "run" | "recorded"; from: string | null; recordTo: string | null };
	crux: { mode: "none" | "api" | "recorded"; from: string | null; key: string | null; keyEnv: string };
	chromePath: string;
	chromeNoSandbox: boolean;
	chromeTrustSpki: string[]; // loopback TLS fixtures only (audit.ts refuses it otherwise)
	repo: string | null;
	now?: Date;
}

export type CollectOptionsRecord = Omit<CollectOptions, "now" | "crux"> & { crux: Omit<CollectOptions["crux"], "key"> & { keySet: boolean } };

// Robots tokens recorded per audited URL; the rule families read their own from robotsVerdict.
export const VERDICT_TOKENS = [
	"Googlebot",
	"Googlebot-Image",
	"Bingbot",
	"OAI-SearchBot",
	"GPTBot",
	"ClaudeBot",
	"Claude-SearchBot",
	"Claude-User",
	"PerplexityBot",
	"Google-Extended",
	"Applebot",
	"Applebot-Extended",
	"CCBot",
	"meta-webindexer",
	"meta-externalagent",
];

const PAGE_MAX_BYTES = 10 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 1024 * 1024; // past RFC 9309's 500 KiB parsing floor, so RBT-005 can see the excess
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024 + 1;
const MAX_SITEMAPS = 20;
const MAX_INDEX_CHILDREN = 10;

function isHtml(f: FetchResult): boolean {
	const ct = f.headers["content-type"] ?? "";
	return f.status !== null && f.body !== null && (/html/i.test(ct) || (!ct && /^\s*(<!doctype html|<html)/i.test(f.body)));
}

async function layer(html: string, headers: Record<string, string> | null): Promise<LayerEvidence> {
	const signals = await extractSignals(html);
	return { html, signals, jsonld: extractJsonLd(signals), directives: robotsDirectives(signals, headers) };
}

// The canonical URLs a page declares in raw-HTML <head> and in `Link` headers, resolved against the final URL.
export function declaredCanonicals(p: PageEvidence): { href: string; resolved: string | null; source: "html" | "header" }[] {
	const out: { href: string; resolved: string | null; source: "html" | "header" }[] = [];
	for (const c of p.raw?.signals.canonicals ?? [])
		if (c.region === "head") out.push({ href: c.href, resolved: normaliseUrl(c.href, p.fetch.finalUrl), source: "html" });
	for (const l of parseLinkHeader(p.fetch.headers.link))
		if (l.params.rel?.split(/\s+/).includes("canonical")) out.push({ href: l.href, resolved: normaliseUrl(l.href, p.fetch.finalUrl), source: "header" });
	return out;
}

// The URLs a crawler fetches for a page: the requested URL, then every redirect hop that answered, in order.
export function crawledUrls(p: PageEvidence): string[] {
	const out: Record<string, string> = {};
	for (const u of [p.url, ...p.fetch.hops.map((h) => h.url)]) out[normaliseUrl(u) ?? u] ??= u;
	return Object.values(out);
}

export interface RobotsBlock {
	url: string; // the crawled URL robots.txt disallows: the page's own URL or a redirect hop after it
	site: SiteEvidence; // the site whose robots.txt decided
	verdict: RobotsVerdict;
}

// The first URL a crawler fetches for a page (crawledUrls) that its own origin's robots.txt disallows for the crawler
// named by `tokens` (most specific first), with the deciding verdict. A disallowed redirect hop keeps the crawler from
// the page as surely as a disallowed requested URL. null when every one is allowed or has no usable robots.txt.
export function pageRobotsBlock(sites: SiteEvidence[], p: PageEvidence, tokens: string[]): RobotsBlock | null {
	for (const url of crawledUrls(p)) {
		const site = sites.find((s) => s.origin === new URL(url).origin);
		if (!site?.robots.parsed) continue;
		const verdict = robotsVerdict(site.robots.parsed, tokens, pathOf(url));
		if (!verdict.allowed) return { url, site, verdict };
	}
	return null;
}

// The tail a robots rule's `observed` adds when the disallowed URL is a redirect hop rather than the page's own URL.
export function redirectNote(p: PageEvidence, block: RobotsBlock): string {
	return block.url === p.url ? "" : `, reached by redirect from ${pathOf(p.url)} (robots.txt ${block.site.robots.url})`;
}

function robotsState(f: FetchResult): RobotsEvidence["state"] {
	if (f.status === null) return "failed";
	if (f.status === 429 || f.status >= 500) return "unreachable";
	if (f.status >= 400) return "unavailable";
	if (f.status >= 200 && f.status < 300) return bodyError(f) ? "failed" : "ok";
	return "unavailable";
}

export async function collect(o: CollectOptions): Promise<Evidence> {
	const now = o.now ?? new Date();
	const guard = new Guard(o.allowLocal);
	const budget = new Budget(o.budget);
	const { key: _key, ...cruxRecord } = o.crux;
	const { now: _now, crux: _crux, ...optionsRest } = o;
	const ev: Evidence = {
		tool: "seo-audit",
		version: 1,
		auditTime: now.toISOString(),
		targets: o.targets,
		intentNoindex: o.intentNoindex,
		options: { ...optionsRest, crux: { ...cruxRecord, keySet: o.crux.key !== null } },
		pages: [],
		sites: [],
		source: null,
		guard: { allowLocal: o.allowLocal, refusals: guard.refusals, budget: { max: budget.max, used: 0, exhausted: 0 }, proxyRuns: [] },
		notChecked: [],
		incomplete: [],
	};
	const fetched = new Map<string, PageEvidence>();
	const fetchPage = async (url: string, role: PageEvidence["role"], maxRedirects: number): Promise<PageEvidence> => {
		const f = await fetchChain(url, { guard, budget, maxRedirects, maxBytes: PAGE_MAX_BYTES });
		const page: PageEvidence = {
			url,
			role,
			fetch: f,
			raw: isHtml(f) && f.body !== null ? await layer(f.body, f.headers) : null,
			rendered: null,
			renderNote: null,
			uaProbes: [],
			lighthouse: null,
			crux: null,
		};
		ev.pages.push(page);
		const key = normaliseUrl(url);
		if (key && !fetched.has(key)) fetched.set(key, page);
		return page;
	};

	// 1. Audited pages.
	const audited: PageEvidence[] = [];
	for (const t of o.targets) {
		const p = await fetchPage(t, "audited", 20);
		audited.push(p);
		const lostBody = bodyError(p.fetch);
		if (p.fetch.status === null)
			ev.incomplete.push(`raw fetch of ${t} failed: ${p.fetch.refused ?? p.fetch.error ?? (p.fetch.budgetExhausted ? "budget exhausted" : p.fetch.loop ? "redirect loop" : "too many redirects")}`);
		else if (lostBody) ev.incomplete.push(`raw fetch of ${t} answered ${p.fetch.status} but its body could not be read: ${lostBody}`);
	}

	// 2. Per origin: robots.txt, sitemaps, llms.txt. The audited URLs' own origins come first; an origin reached only by
	// an audited URL's redirect gets its robots.txt alone, so the robots verdicts cover every URL a crawler fetches.
	const reachedBy: Record<string, SiteEvidence["reachedBy"]> = {};
	for (const t of o.targets) reachedBy[new URL(t).origin] = "target";
	for (const p of audited) for (const u of crawledUrls(p)) reachedBy[new URL(u).origin] ??= "redirect";
	for (const [origin, via] of Object.entries(reachedBy)) {
		const robotsUrl = `${origin}/robots.txt`;
		const rf = await fetchChain(robotsUrl, { guard, budget, maxRedirects: 10, maxBytes: ROBOTS_MAX_BYTES });
		const state = robotsState(rf);
		const parsed = state === "ok" && rf.body !== null ? parseRobots(rf.body) : null;
		const robots: RobotsEvidence = { url: robotsUrl, fetch: rf, state, parsed, verdicts: [] };
		// The robots fetch is a mandatory layer (plan section 3): a 5xx or 429 fails it as surely as no response, and a
		// 2xx whose body could not be read leaves no rules to apply.
		if (state === "failed" || state === "unreachable")
			ev.incomplete.push(
				`robots.txt fetch for ${origin} failed: ${
					state === "unreachable"
						? `answered ${rf.status}`
						: rf.status !== null
							? `answered ${rf.status} but its body could not be read: ${rf.error}`
							: (rf.refused ?? rf.error ?? (rf.budgetExhausted ? "budget exhausted" : "no final response"))
				}`,
			);
		const site: SiteEvidence = { origin, reachedBy: via, robots, sitemaps: [], llms: null, sample: [] };
		ev.sites.push(site);
		if (parsed)
			for (const p of audited)
				for (const url of crawledUrls(p).filter((u) => new URL(u).origin === origin))
					for (const token of VERDICT_TOKENS) robots.verdicts.push({ url, token, ...robotsVerdict(parsed, [token], pathOf(url)) });
		if (via === "redirect") continue;

		const host = new URL(origin).host;
		const queue: SitemapEvidence[] = [];
		for (const s of parsed?.sitemaps ?? []) {
			const abs = isAbsoluteHttpUrl(s.value) ? normaliseUrl(s.value) : null;
			const entry: SitemapEvidence = { url: abs ?? s.value, via: "robots", robotsLine: s.line, parent: null, fetch: null, skipped: null, parsed: null, childrenNotQueued: 0 };
			if (!abs) entry.skipped = "not an absolute URL";
			else if (new URL(abs).host !== host) entry.skipped = "on another host than the audited origin; not fetched";
			queue.push(entry);
		}
		const defaultUrl = `${origin}/sitemap.xml`;
		if (!queue.some((s) => s.url === defaultUrl))
			queue.push({ url: defaultUrl, via: "default", robotsLine: null, parent: null, fetch: null, skipped: null, parsed: null, childrenNotQueued: 0 });
		const seen = new Set<string>();
		for (let n = 0; n < queue.length; n++) {
			const s = queue[n];
			if (!s) continue;
			site.sitemaps.push(s);
			if (s.skipped) continue;
			if (seen.has(s.url)) {
				s.skipped = "already fetched in this run";
				continue;
			}
			if (seen.size >= MAX_SITEMAPS) {
				s.skipped = `sitemap fetch limit (${MAX_SITEMAPS}) reached`;
				continue;
			}
			seen.add(s.url);
			s.fetch = await fetchChain(s.url, { guard, budget, maxRedirects: 10, maxBytes: SITEMAP_MAX_BYTES });
			if (s.fetch.status === 200 && s.fetch.body !== null) s.parsed = parseSitemap(s.fetch.body, s.fetch.finalUrl);
			const children = s.parsed?.sitemaps ?? [];
			s.childrenNotQueued = Math.max(children.length - MAX_INDEX_CHILDREN, 0);
			for (const child of children.slice(0, MAX_INDEX_CHILDREN)) {
				const abs = child.loc && isAbsoluteHttpUrl(child.loc) ? normaliseUrl(child.loc) : null;
				if (abs && queue.some((q) => q.url === abs)) continue;
				const entry: SitemapEvidence = { url: abs ?? child.loc ?? "", via: "index", robotsLine: null, parent: s.url, fetch: null, skipped: null, parsed: null, childrenNotQueued: 0 };
				if (!abs) entry.skipped = "not an absolute URL";
				else if (new URL(abs).host !== host) entry.skipped = "on another host than the sitemap index; not fetched";
				queue.push(entry);
			}
		}
		site.llms = await fetchChain(`${origin}/llms.txt`, { guard, budget, maxRedirects: 5, maxBytes: PAGE_MAX_BYTES });
	}

	// 3. Canonical targets: one GET each, redirects not followed.
	for (const p of audited)
		for (const c of declaredCanonicals(p)) {
			if (!c.resolved || c.resolved === normaliseUrl(p.fetch.finalUrl) || fetched.has(c.resolved)) continue;
			await fetchPage(c.resolved, "canonical-target", 0);
		}

	// 4. Sitemap sample: the first --sample distinct same-host <loc> URLs, GET, redirects not followed.
	for (const site of ev.sites) {
		const host = new URL(site.origin).host;
		const locs: string[] = [];
		for (const s of site.sitemaps)
			for (const u of s.parsed?.urls ?? []) {
				if (locs.length >= o.sample) break;
				const loc = u.loc;
				if (!loc || loc.length >= 2048 || !isAbsoluteHttpUrl(loc)) continue;
				const abs = normaliseUrl(loc);
				if (!abs || new URL(abs).host !== host || locs.includes(abs)) continue;
				locs.push(abs);
			}
		site.sample = locs;
		for (const loc of locs) if (!fetched.has(loc)) await fetchPage(loc, "sample", 0);
	}

	// 5. UA probes for the audited URLs.
	for (const p of audited) p.uaProbes = await probeUserAgents(p.url, guard, budget);

	// 6. Field data.
	for (const p of audited) {
		if (o.crux.mode === "recorded" && o.crux.from) p.crux = loadCrux(o.crux.from, p.url);
		else if (o.crux.mode === "api" && o.crux.key) p.crux = await queryCrux(o.crux.key, p.url, guard, budget);
		else p.crux = noCrux(`field data unavailable: no ${o.crux.keyEnv} set`);
	}

	// 7. Rendered DOM and Lighthouse, through the guard proxy.
	let proxy: GuardProxy | null = null;
	if (o.render.mode === "chrome" || o.lighthouse.mode === "run") {
		proxy = new GuardProxy(guard);
		await proxy.start();
	}
	try {
		for (const p of audited) {
			let page: RenderedPage | null = null;
			if (o.render.mode === "recorded" && o.render.from) {
				page = loadRecording(o.render.from, p.url);
				if (!page) p.renderNote = `no recorded render for ${p.url} in ${o.render.from}`;
			} else if (o.render.mode === "chrome" && proxy) {
				page = await renderUrl(p.url, { chromePath: o.chromePath, proxy, noSandbox: o.chromeNoSandbox, trustSpki: o.chromeTrustSpki });
				if (o.render.recordTo) saveRecording(o.render.recordTo, page, o.repo);
			} else p.renderNote = "rendering disabled (--no-render)";
			if (page?.html) {
				const { html, ...log } = page;
				const l = await layer(html, null);
				p.rendered = { ...l, page: log };
			} else if (page) p.renderNote = page.error ?? "render produced no DOM";
		}
		const first = audited[0];
		if (first) {
			if (o.lighthouse.mode === "recorded" && o.lighthouse.from) first.lighthouse = loadLhr(o.lighthouse.from, first.url);
			else if (o.lighthouse.mode === "run" && proxy)
				first.lighthouse = await runLighthouse(first.url, { chromePath: o.chromePath, proxy, noSandbox: o.chromeNoSandbox, trustSpki: o.chromeTrustSpki });
			if (first.lighthouse?.lhr && o.lighthouse.recordTo)
				writeContained(o.lighthouse.recordTo, `${JSON.stringify(first.lighthouse.lhr, null, "\t")}\n`, o.repo);
		}
	} finally {
		if (proxy) {
			ev.guard.proxyRuns = proxy.runs.filter((r) => r.label !== "default");
			await proxy.stop();
		}
	}

	// 8. Source layer.
	if (o.repo) ev.source = scanSource(o.repo);

	ev.guard.budget = { max: budget.max, used: budget.used, exhausted: budget.exhausted };
	ev.notChecked = notChecked(ev, o);
	return ev;
}

function notChecked(ev: Evidence, o: CollectOptions): { item: string; reason: string }[] {
	const out: { item: string; reason: string }[] = [];
	const audited = ev.pages.filter((p) => p.role === "audited");
	for (const p of audited) {
		if (p.crux?.reason) out.push({ item: `field Core Web Vitals for ${p.url}`, reason: p.crux.reason });
		if (!p.rendered) out.push({ item: `rendered DOM for ${p.url}`, reason: p.renderNote ?? "not rendered" });
	}
	const lh = audited[0]?.lighthouse;
	if (o.lighthouse.mode === "off") out.push({ item: "lab metrics (Lighthouse)", reason: "Lighthouse disabled (--no-lighthouse)" });
	else if (!lh || lh.error) out.push({ item: "lab metrics (Lighthouse)", reason: lh?.error ?? "no Lighthouse result" });
	else if (audited.length > 1) out.push({ item: "lab metrics for every --url but the first", reason: "Lighthouse runs on the first --url only" });
	if (ev.pages.some((p) => p.raw?.signals.microdata || p.raw?.signals.rdfa || p.rendered?.signals.microdata || p.rendered?.signals.rdfa))
		out.push({ item: "Microdata and RDFa", reason: "present, not validated" });
	out.push({ item: "hidden text beyond inline-style and attribute signals", reason: "computed visibility is not collected" });
	out.push({ item: "Search Console data (coverage, Core Web Vitals report, URL inspection)", reason: "no Search Console access" });
	out.push({ item: "Bing Webmaster Tools data", reason: "no Bing Webmaster Tools access" });
	out.push({ item: "rendered-only content for AI crawlers other than CCBot", reason: "AI crawler JS rendering is undocumented by the vendor" });
	out.push({ item: "multi-page crawl, link graph and site-wide duplicates", reason: "only the audited URLs and the sitemap sample are fetched" });
	if (ev.guard.proxyRuns.length)
		out.push({ item: "HTTPS requests inside proxy tunnels", reason: "the in-tunnel request count is recorded from CDP and the LHR, not enforced" });
	for (const s of ev.sites) {
		if (s.reachedBy === "redirect")
			out.push({ item: `sitemaps and llms.txt of ${s.origin}`, reason: "reached only by an audited URL's redirect; only its robots.txt is fetched" });
		for (const sm of s.sitemaps) {
			if (sm.skipped && sm.skipped !== "already fetched in this run") out.push({ item: `sitemap ${sm.url}`, reason: sm.skipped });
			if (sm.childrenNotQueued)
				out.push({ item: `${sm.childrenNotQueued} sitemap(s) listed in ${sm.url}`, reason: `only the first ${MAX_INDEX_CHILDREN} entries of an index are fetched` });
		}
	}
	if (ev.guard.budget.exhausted) out.push({ item: `${ev.guard.budget.exhausted} request(s)`, reason: `request budget (--budget ${ev.guard.budget.max}) exhausted` });
	return out;
}
