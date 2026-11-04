// AI search and Bing family: the rules.md categories ai-policy, ai-search, ai-access, llms-txt and bing, plus the
// do-not-flag notes on the same evidence (DNF-15, AI-003, AI-021, NF-AI-2, NF-AI-10, NF-BNG-4, NF-03, NF-AI-1). The
// spam category has judgment rows only. Every check reads Evidence only (see scripts/rules/README.md).
import type { Layer } from "../lib/catalogue.ts";
import { type RobotsDirective, robotsDirectives } from "../lib/directives.ts";
import type { Check, Hit, RuleContext } from "../lib/engine.ts";
import { type PageEvidence, pageRobotsBlock, redirectNote, type SiteEvidence } from "../lib/evidence.ts";
import type { HtmlSignals } from "../lib/html.ts";
import { type ParsedRobots, type RobotsGroup, rulesFor } from "../lib/robots.ts";
import { pathOf } from "../lib/url.ts";

const DIRECTIVE_LAYER: Record<RobotsDirective["source"], Layer> = { meta: "raw-html", header: "headers" };
// Statuses an edge answers a blocked crawler with (rules.md AI-005, AI-013, AI-022, AI-036).
const EDGE_BLOCK: Record<number, true> = { 401: true, 403: true, 429: true, 503: true };
const LLMS_ABSENT: Record<number, true> = { 404: true, 410: true };
// AI-050: rendered main text above this length that the raw HTML lacks.
const MAIN_TEXT_MIN = 200;
// BNG-003: the detection floor of lastmod values in one sitemap.
const LASTMOD_FLOOR = 5;

// --- robots.txt -----------------------------------------------------------------------------------------------------

// A hit for each audited URL that robots.txt keeps from the crawler named by `tokens` (most specific first; the first
// token with a named group decides, then `*`): the URL itself or a redirect hop after it is disallowed on its own
// origin. Located on the deciding robots.txt line.
function disallowHits(ctx: RuleContext, tokens: string[]): Hit[] {
	const out: Hit[] = [];
	for (const p of ctx.audited) {
		const block = pageRobotsBlock(ctx.evidence.sites, p, tokens);
		if (!block) continue;
		const v = block.verdict;
		out.push({
			url: p.url,
			locator: `robots.txt:line:${v.rule?.line ?? 0}`,
			layer: "robots",
			observed: `${tokens[0]}: Disallow: ${v.rule?.path ?? "?"} in the ${v.group ?? "?"} group matches ${pathOf(block.url)}${redirectNote(p, block)}`,
		});
	}
	return out;
}

function parsedSites(ctx: RuleContext): { site: SiteEvidence; parsed: ParsedRobots }[] {
	return ctx.evidence.sites.flatMap((site) => (site.robots.parsed ? [{ site, parsed: site.robots.parsed }] : []));
}

// The groups that name `token` (RFC 9309 section 2.2.1: by product token, case-insensitively), each with the
// user-agent line that names it.
function namedGroups(parsed: ParsedRobots, token: string): { group: RobotsGroup; line: number }[] {
	return parsed.groups.flatMap((group) => {
		const i = group.agents.findIndex((a) => (a.match(/^[A-Za-z_-]+/)?.[0] ?? "").toLowerCase() === token.toLowerCase());
		return i < 0 ? [] : [{ group, line: group.agentLines[i] ?? 0 }];
	});
}

// A do-not-flag note for each robots.txt group that names `token` and disallows something, on its user-agent line.
function namedDisallowNotes(ctx: RuleContext, token: string, says: string): Hit[] {
	const out: Hit[] = [];
	for (const { site, parsed } of parsedSites(ctx))
		for (const { group, line } of namedGroups(parsed, token)) {
			const rule = group.rules.find((r) => !r.allow && r.path);
			if (rule)
				out.push({ url: site.robots.fetch.finalUrl, locator: `line:${line}`, layer: "robots", observed: `User-agent: ${token} / Disallow: ${rule.path} (line ${rule.line}): ${says}` });
		}
	return out;
}

// BNG-014: each `*`-group disallow path that no rule of the bingbot group repeats.
function unrepeatedForBing(parsed: ParsedRobots): { path: string; line: number }[] {
	const bing = rulesFor(parsed, "bingbot");
	if (!bing || bing.group === "*") return [];
	const star = rulesFor(parsed, "*");
	if (!star) return [];
	const bingPaths = new Set(bing.rules.map((r) => r.path));
	return star.rules.filter((r) => !r.allow && r.path && !bingPaths.has(r.path)).map((r) => ({ path: r.path, line: r.line }));
}

// --- rendered vs raw ------------------------------------------------------------------------------------------------

interface HeadSignal {
	locator: string;
	label: string;
	value: (s: HtmlSignals) => string | null;
}

const title: HeadSignal = { locator: "html:head > title", label: "<title>", value: (s) => s.titles.find((t) => t.text)?.text ?? null };
const description: HeadSignal = {
	locator: "html:meta[name=description]",
	label: "meta description",
	value: (s) => s.metas.find((m) => m.key === "name" && m.name === "description" && m.content.trim())?.content ?? null,
};
const canonical: HeadSignal = { locator: "html:link[rel=canonical]", label: "canonical", value: (s) => s.canonicals.find((c) => c.href)?.href ?? null };
const h1: HeadSignal = { locator: "html:h1", label: "h1", value: (s) => s.headings.find((h) => h.level === 1 && h.text)?.text ?? null };

// Each signal the rendered DOM has and the raw HTML lacks, emitted on the rendered layer (README: a rule that compares
// raw with rendered emits `rendered`).
function renderedOnly(p: PageEvidence, signals: HeadSignal[]): Hit[] {
	const raw = p.raw?.signals;
	const rendered = p.rendered?.signals;
	if (!raw || !rendered) return [];
	const out: Hit[] = [];
	for (const sig of signals) {
		const v = sig.value(rendered);
		if (v !== null && sig.value(raw) === null)
			out.push({ url: p.fetch.finalUrl, locator: sig.locator, layer: "rendered", observed: `${sig.label} "${v}" is in the rendered DOM only` });
	}
	return out;
}

// --- UA probes ------------------------------------------------------------------------------------------------------

function edgeBlockHits(ctx: RuleContext, probes: string[]): Hit[] {
	const out: Hit[] = [];
	for (const p of ctx.audited) {
		if (p.fetch.status !== 200) continue;
		for (const probe of p.uaProbes) {
			if (!probes.includes(probe.probe)) continue;
			const blocked = probe.status !== null && EDGE_BLOCK[probe.status] === true;
			// A challenge counts only when the probe got another document than the default fetch (same extractor, so a page
			// that merely mentions a captcha is not a challenge served to the crawler).
			const raw = p.raw?.signals;
			const sameDocument = !!raw && probe.title === (raw.titles[0]?.text ?? null) && probe.mainTextLength === raw.mainText.length;
			const challenged = probe.challenge && !sameDocument;
			if (!blocked && !challenged) continue;
			const got = blocked ? `status ${probe.status}` : `a challenge page (status ${probe.status})`;
			out.push({ url: p.url, locator: `ua-probe:${probe.probe}`, layer: "ua-probe", observed: `${probe.probe} got ${got} while the default fetch got 200; ${probe.label}` });
		}
	}
	return out;
}

// --- llms.txt -------------------------------------------------------------------------------------------------------

// The /llms.txt text when it answered 200 with a text body (an HTML fallback page is not an llms.txt file).
function llmsText(site: SiteEvidence): string | null {
	const f = site.llms;
	if (!f || f.status !== 200 || f.body === null || /html/i.test(f.headers["content-type"] ?? "")) return null;
	return f.body;
}

function llmsAbsent(ctx: RuleContext, observed: string): Hit[] {
	return ctx.evidence.sites.flatMap((site) => {
		const f = site.llms;
		return f && f.status !== null && LLMS_ABSENT[f.status] ? [{ url: f.requestedUrl, locator: "doc", layer: "site" as const, observed: `/llms.txt answered ${f.status}; ${observed}` }] : [];
	});
}

const LIST_ITEM = /^\s*[-*+]\s+/;
const LINK_ITEM = /^\s*[-*+]\s+\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/;

// --- sitemaps -------------------------------------------------------------------------------------------------------

// The UTC calendar date of a W3C Datetime value, or null when it does not parse.
function utcDate(v: string): string | null {
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
	const t = Date.parse(v);
	return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export const rules: Record<string, Check> = {
	// ai-search: crawlers that feed AI search surfaces

	"AI-001": (ctx) => disallowHits(ctx, ["OAI-SearchBot"]),
	"AI-010": (ctx) => disallowHits(ctx, ["Claude-SearchBot"]),
	"AI-020": (ctx) => disallowHits(ctx, ["PerplexityBot"]),
	// Apple's documented fallback: with no Applebot group, the Googlebot group applies, then `*`.
	"AI-060": (ctx) => disallowHits(ctx, ["Applebot", "Googlebot"]),
	"AI-074": (ctx) => disallowHits(ctx, ["meta-webindexer"]),

	// Admitted for CCBot alone (Common Crawl executes no JavaScript); for other AI crawlers this is Not checked.
	"AI-050": (ctx) =>
		ctx.audited.flatMap((p) => {
			const hits = renderedOnly(p, [title, h1, canonical]).map((h) => ({ ...h, observed: `${h.observed}; CCBot (Common Crawl) does not execute JavaScript` }));
			const raw = p.raw?.signals.mainText ?? "";
			const rendered = p.rendered?.signals.mainText ?? "";
			if (p.raw && p.rendered && rendered.length > MAIN_TEXT_MIN && raw.length <= MAIN_TEXT_MIN)
				hits.push({
					url: p.fetch.finalUrl,
					locator: "html:body",
					layer: "rendered",
					observed: `main text is ${rendered.length} characters in the rendered DOM, ${raw.length} in the raw HTML; CCBot (Common Crawl) does not execute JavaScript`,
				});
			return hits;
		}),

	// ai-policy: training and user-fetch opt-outs (observations)

	"AI-002": (ctx) => disallowHits(ctx, ["GPTBot"]),
	"AI-011": (ctx) => disallowHits(ctx, ["ClaudeBot"]),
	"AI-012": (ctx) => disallowHits(ctx, ["Claude-User"]),
	"AI-035": (ctx) => disallowHits(ctx, ["Google-Extended"]),
	"AI-061": (ctx) => disallowHits(ctx, ["Applebot-Extended"]),
	"AI-070": (ctx) => disallowHits(ctx, ["CCBot"]),
	"AI-075": (ctx) => disallowHits(ctx, ["meta-externalagent"]),

	// ai-access: UA probes the edge answers differently (observations; a probe is not the real crawler)

	"AI-005": (ctx) => edgeBlockHits(ctx, ["oai-searchbot"]),
	"AI-013": (ctx) => edgeBlockHits(ctx, ["claudebot", "claude-searchbot"]),
	"AI-022": (ctx) => edgeBlockHits(ctx, ["perplexitybot"]),
	"AI-036": (ctx) => edgeBlockHits(ctx, ["googlebot-smartphone", "googlebot-desktop"]),

	// llms-txt (observations)

	"AI-090": (ctx) => llmsAbsent(ctx, "absent; an optional convention, not a ranking or citation lever"),

	"AI-091": (ctx) =>
		ctx.evidence.sites.flatMap((site) => {
			const f = site.llms;
			return f && f.status !== null && f.status >= 500 ? [{ url: f.requestedUrl, locator: "doc", layer: "site" as const, observed: `/llms.txt answered ${f.status}` }] : [];
		}),

	"AI-091b": (ctx) =>
		ctx.evidence.sites.flatMap((site) => {
			const text = llmsText(site);
			if (text === null || text.split(/\r\n|\r|\n/).some((l) => l.startsWith("# "))) return [];
			return [{ url: site.llms?.finalUrl ?? `${site.origin}/llms.txt`, locator: "doc", layer: "site" as const, observed: "/llms.txt answered 200 with no H1 line (`# `)" }];
		}),

	"AI-092": (ctx) =>
		ctx.evidence.sites.flatMap((site) => {
			const text = llmsText(site);
			if (text === null) return [];
			const out: Hit[] = [];
			let underH2 = false;
			text.split(/\r\n|\r|\n/).forEach((l, i) => {
				if (/^##\s/.test(l)) underH2 = true;
				else if (/^#\s/.test(l)) underH2 = false;
				else if (underH2 && LIST_ITEM.test(l) && !LINK_ITEM.test(l))
					out.push({ url: site.llms?.finalUrl ?? `${site.origin}/llms.txt`, locator: `line:${i + 1}`, layer: "site", observed: `list item does not start with a [name](url) link: ${l.trim()}` });
			});
			return out;
		}),

	// bing

	"BNG-001": (ctx) => disallowHits(ctx, ["bingbot"]),

	"BNG-003": (ctx) =>
		ctx.evidence.sites.flatMap((site) =>
			site.sitemaps.flatMap((s) => {
				if (s.fetch?.status !== 200 || !s.parsed) return [];
				const lastmods = s.parsed.urls.flatMap((u) => (u.lastmod === null ? [] : [u.lastmod]));
				const today = ctx.auditTime.toISOString().slice(0, 10);
				if (lastmods.length < LASTMOD_FLOOR || !lastmods.every((v) => utcDate(v) === today)) return [];
				return [{ url: s.fetch.finalUrl, locator: "doc", layer: "sitemap" as const, observed: `all ${lastmods.length} <lastmod> values are ${today}, the fetch date (UTC)` }];
			}),
		),

	"BNG-009": (ctx) =>
		ctx.audited.flatMap((p) => {
			const hits = renderedOnly(p, [title, description, canonical]);
			if (!p.raw || !p.rendered) return hits;
			// Robots metas, generic or crawler-named, selected the way scripts/lib/directives.ts reads them.
			const seen = new Set(p.raw.signals.metas.filter((m) => m.key === "name").map((m) => m.name));
			for (const m of p.rendered.signals.metas) {
				if (m.key !== "name" || (m.name !== "robots" && !/bot/.test(m.name)) || seen.has(m.name)) continue;
				seen.add(m.name);
				hits.push({ url: p.fetch.finalUrl, locator: `html:meta[name=${m.name}]`, layer: "rendered", observed: `<meta name="${m.name}" content="${m.content}"> is in the rendered DOM only` });
			}
			return hits;
		}),

	"BNG-010": (ctx) =>
		ctx.audited.flatMap((p) => {
			const seen = new Set<string>();
			const out: Hit[] = [];
			for (const d of p.raw?.directives ?? robotsDirectives(null, p.fetch.headers)) {
				if ((d.scope !== "*" && d.scope !== "bingbot") || (d.name !== "noarchive" && d.name !== "nocache") || seen.has(d.locator)) continue;
				seen.add(d.locator);
				out.push({ url: p.fetch.finalUrl, locator: d.locator, layer: DIRECTIVE_LAYER[d.source], observed: d.raw });
			}
			return out;
		}),

	"BNG-012": (ctx) =>
		ctx.audited.flatMap((p) =>
			p.fetch.status === 200 && p.raw && description.value(p.raw.signals) === null
				? [{ url: p.fetch.finalUrl, locator: "html:head", layer: "raw-html" as const, observed: "no <meta name=\"description\"> with content in the raw HTML" }]
				: [],
		),

	"BNG-014": (ctx) =>
		parsedSites(ctx).flatMap(({ site, parsed }) =>
			unrepeatedForBing(parsed).map((r) => ({
				url: site.robots.fetch.finalUrl,
				locator: `line:${r.line}`,
				layer: "robots" as const,
				observed: `Disallow: ${r.path} in the * group is repeated in no rule of the bingbot group`,
			})),
		),

	"BNG-025": (ctx) =>
		ctx.evidence.sites.flatMap((site) => {
			const def = site.sitemaps.find((s) => s.via === "default");
			if (site.robots.fetch.status !== 200 || !site.robots.parsed || site.robots.parsed.sitemaps.length || def?.fetch?.status !== 200) return [];
			return [{ url: site.robots.fetch.finalUrl, locator: "doc", layer: "robots" as const, observed: `${def.url} answered 200 and robots.txt has no Sitemap: line` }];
		}),
};

export const notes: Record<string, Check> = {
	"DNF-15": (ctx) =>
		parsedSites(ctx).flatMap(({ site, parsed }) =>
			parsed.lines
				.filter((l) => l.key === "crawl-delay")
				.map((l) => ({ url: site.robots.fetch.finalUrl, locator: `line:${l.line}`, layer: "robots" as const, observed: `${l.raw.trim()}: not supported by Google` })),
		),

	"AI-003": (ctx) => namedDisallowNotes(ctx, "ChatGPT-User", "user-initiated fetches may not follow robots.txt; not guaranteed either way"),
	"AI-021": (ctx) => namedDisallowNotes(ctx, "Perplexity-User", "this user-requested fetcher generally ignores robots.txt; not a defect either way"),
	"NF-AI-2": (ctx) => namedDisallowNotes(ctx, "Google-Extended", "does not affect Google Search inclusion or ranking"),
	"NF-AI-10": (ctx) => namedDisallowNotes(ctx, "Applebot-Extended", "does not remove the site from Apple search results"),

	// A bingbot group that repeats every `*` rule: its existence alone is not flagged (BNG-014 covers the missing rules).
	"NF-BNG-4": (ctx) =>
		parsedSites(ctx).flatMap(({ site, parsed }) => {
			const named = namedGroups(parsed, "bingbot")[0];
			if (!named || unrepeatedForBing(parsed).length) return [];
			return [{ url: site.robots.fetch.finalUrl, locator: `line:${named.line}`, layer: "robots" as const, observed: "a bingbot group that repeats every * disallow; per-bot groups are allowed" }];
		}),

	"NF-03": (ctx) => llmsAbsent(ctx, "no llms.txt or AI-only file is needed for generative AI search"),
	"NF-AI-1": (ctx) => llmsAbsent(ctx, "Google Search does not use llms.txt"),
};
