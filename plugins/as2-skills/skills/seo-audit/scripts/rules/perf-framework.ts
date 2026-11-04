// Performance and framework family: the rules.md categories core-web-vitals (field data from CrUX), lab (a Lighthouse 13
// result), performance (raw-HTML and rendered markup) and framework (text detectors over the `--repo` source layer),
// plus the do-not-flag notes DNF-18, FW-DNF-11 and FW-DNF-12. Every check reads Evidence only (scripts/rules/README.md).
//
// Locators this family adds to the README's forms:
//   field   `crux:<url|origin>:<metric>` (the CrUX record the p75 came from), `crux` for the whole lookup (CWV-010)
//   lab     `lhr:<audit id>`
//   source  hit url = the file's path relative to --repo; locator `line:N`, or `doc` for a file-level absence
import type { Check, Hit, RuleContext } from "../lib/engine.ts";
import type { PageEvidence } from "../lib/evidence.ts";
import { type HtmlSignals, scanHead } from "../lib/html.ts";
import type { Json } from "../lib/jsonld.ts";
import type { LighthouseEvidence } from "../lib/lighthouse.ts";
import {
	type Entry,
	type MetadataObject,
	ancestorLayouts,
	appFiles,
	arrayElements,
	childEntries,
	isClientFile,
	isLayout,
	isPage,
	lineAt,
	metadataExports,
	nextAppDir,
	stringValue,
	urlValue,
	viteSpaIndex,
} from "../lib/perf-framework-source.ts";
import type { RenderedMedia } from "../lib/render.ts";
import type { SourceEvidence, SourceFile } from "../lib/source.ts";
import { normaliseUrl } from "../lib/url.ts";

const REDIRECT: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
// Script types a browser executes as a classic script; any other non-module type is a data block, never fetched.
const CLASSIC_SCRIPT: Record<string, true> = {
	"": true,
	"text/javascript": true,
	"application/javascript": true,
	"application/ecmascript": true,
	"application/x-javascript": true,
	"text/ecmascript": true,
};

type Metric = "largest_contentful_paint" | "interaction_to_next_paint" | "cumulative_layout_shift";
const P75_KEY: Record<Metric, "lcp" | "inp" | "cls"> = {
	largest_contentful_paint: "lcp",
	interaction_to_next_paint: "inp",
	cumulative_layout_shift: "cls",
};
const UNIT: Record<Metric, string> = { largest_contentful_paint: " ms", interaction_to_next_paint: " ms", cumulative_layout_shift: "" };

// CWV-001..003b: CrUX p75 in (low, high], high null for the open "poor" band. The URL record is used first and the
// origin record as fallback (scripts/lib/crux.ts); the locator names which one.
function field(metric: Metric, low: number, high: number | null): Check {
	return (ctx) =>
		ctx.audited.flatMap((p) => {
			const scope = p.crux?.scope;
			const v = p.crux?.p75[P75_KEY[metric]];
			if (!scope || v === null || v === undefined || v <= low || (high !== null && v > high)) return [];
			const record = scope === "origin" ? `origin record ${new URL(p.url).origin}, the URL has too little data` : "URL record";
			return [
				{ url: p.url, locator: `crux:${scope}:${metric}`, layer: "field", observed: `p75 ${v}${UNIT[metric]} (${record}; CrUX ${p.crux?.source}, phone)` },
			];
		});
}

// The Lighthouse 13 result of the first audited URL, when one parsed without error.
function lab(ctx: RuleContext): { page: PageEvidence; lh: LighthouseEvidence } | null {
	const page = ctx.audited[0];
	const lh = page?.lighthouse;
	return page && lh && !lh.error ? { page, lh } : null;
}

// What an insight's details name: node snippets and request URLs, depth-first, first few.
function detailNames(details: Json | null): string[] {
	const out: string[] = [];
	const walk = (v: Json | undefined) => {
		if (out.length >= 3 || v === undefined || v === null || typeof v !== "object") return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v.type === "node" && typeof v.snippet === "string") out.push(v.snippet);
		else if (typeof v.url === "string") out.push(v.url);
		for (const [k, x] of Object.entries(v)) if (k !== "debugData") walk(x);
	};
	walk(details);
	return [...new Set(out)];
}

function metricOver(audit: string, limit: number, unit: string): Check {
	return (ctx) => {
		const run = lab(ctx);
		const v = run?.lh.audits[audit]?.numericValue;
		if (!run || v === null || v === undefined || v <= limit) return [];
		return [
			{
				url: run.page.fetch.finalUrl,
				locator: `lhr:${audit}`,
				layer: "lab",
				observed: `numericValue ${Math.round(v * 1000) / 1000}${unit} (lab diagnostic, Lighthouse ${run.lh.lighthouseVersion}, one throttled run; not a Core Web Vitals verdict)`,
			},
		];
	};
}

function insightFails(audit: string): Check {
	return (ctx) => {
		const run = lab(ctx);
		const a = run?.lh.audits[audit];
		if (!run || !a || a.score === null || a.score >= 1) return [];
		const names = detailNames(a.details);
		return [
			{
				url: run.page.fetch.finalUrl,
				locator: `lhr:${audit}`,
				layer: "lab",
				observed: `score ${a.score} (Lighthouse ${run.lh.lighthouseVersion})${names.length ? `: ${names.join(", ")}` : ""}`,
			},
		];
	};
}

// CWV-040: an <img> or <video> without both width and height attributes and without an inline aspect-ratio, unless the
// rendered DOM's computed style shows a stylesheet reserving its box: a computed aspect-ratio other than `auto` on an
// element without both attributes (the attributes alone compute to `auto W / H`).
// Correspondence, which decides whose computed style an element is credited with:
// - rendered media to rendered elements: by position within each tag, both being document order of the same DOM,
//   when the sequences agree on length and src; otherwise as below, without ids;
// - raw elements to rendered elements: by tag and id when one rendered element carries that id, else by tag and src
//   resolved against each layer's base URL (`/hero.svg` raw and `https://host/hero.svg` hydrated are one element)
//   when that source occurs once in each layer.
// An element with no established counterpart (none at all, or a duplicated source no id disambiguates) is flagged
// without claiming the computed style lacks an aspect-ratio. A rendered finding is dropped as a duplicate of a raw
// one only when its element corresponds to the reported raw element. A recording without `media` keeps the
// markup-only check.
interface MediaElement {
	tag: string;
	id: string | null;
	identity: string; // tag and resolved src
	src: string; // as written
	attrs: Record<string, string>;
	ordinal: number; // 1-based position among the layer's elements of this tag
}

interface Unsized {
	index: number; // position in the layer's element list
	identity: string;
	locator: string;
	observed: string;
}

const present = (v: string | null | undefined): boolean => (v ?? "").trim() !== "";

// `tag|src`, the src resolved against `base` (the page URL, or its <base href> resolved against it). An empty src stays
// empty, and one that does not parse stays as written.
function mediaIdentity(tag: string, src: string, base: string): string {
	if (!src) return `${tag}|`;
	try {
		return `${tag}|${new URL(src, base).href}`;
	} catch {
		return `${tag}|${src}`;
	}
}

function layerBase(s: HtmlSignals, pageUrl: string): string {
	try {
		return new URL(s.base ?? pageUrl, pageUrl).href;
	} catch {
		return pageUrl;
	}
}

function mediaElements(s: HtmlSignals, base: string): MediaElement[] {
	const ordinal: Record<string, number> = {};
	return [...s.images.map((i) => ({ tag: "img", attrs: i.attrs })), ...s.videos.map((v) => ({ tag: "video", attrs: v.attrs }))].map(({ tag, attrs }) => {
		const src = attrs.src ?? attrs.poster ?? "";
		ordinal[tag] = (ordinal[tag] ?? 0) + 1;
		return { tag, id: present(attrs.id) ? (attrs.id ?? null) : null, identity: mediaIdentity(tag, src, base), src, attrs, ordinal: ordinal[tag] };
	});
}

function counts(els: { identity: string }[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of els) out[e.identity] = (out[e.identity] ?? 0) + 1;
	return out;
}

// For each element of `from`, the index of its counterpart in `to`, or null when none is established. The mapping is
// one-to-one: first by id (the one `to` element with the same tag and id, when that id is also unique among `from`'s
// elements of that tag), then, among `to` elements no id match claimed, the one with the same identity when that
// identity occurs once in each list and the two do not carry different ids.
function correspond(from: { tag: string; id: string | null; identity: string }[], to: { tag: string; id: string | null; identity: string }[]): (number | null)[] {
	const nFrom = counts(from);
	const nTo = counts(to);
	const out = from.map((e): number | null => {
		if (!e.id || from.filter((f) => f.tag === e.tag && f.id === e.id).length !== 1) return null;
		const byId = to.flatMap((t, i) => (t.tag === e.tag && t.id === e.id ? [i] : []));
		return byId.length === 1 ? (byId[0] ?? null) : null;
	});
	const claimed = new Set(out.filter((i): i is number => i !== null));
	return out.map((m, k) => {
		const e = from[k];
		if (m !== null || !e || nFrom[e.identity] !== 1 || nTo[e.identity] !== 1) return m;
		const i = to.findIndex((t) => t.identity === e.identity);
		const t = to[i];
		return t && !claimed.has(i) && !(e.id && t.id && e.id !== t.id) ? i : null;
	});
}

// For each rendered element, the index of its entry in the rendered media list, or null when none is established.
function renderedMedia(els: MediaElement[], media: RenderedMedia[], base: string): (number | null)[] {
	const out: (number | null)[] = els.map(() => null);
	const fallback: string[] = [];
	for (const tag of ["img", "video"]) {
		const e = els.flatMap((x, i) => (x.tag === tag ? [i] : []));
		const m = media.flatMap((x, i) => (x.tag === tag ? [i] : []));
		if (e.length === m.length && e.every((ei, k) => els[ei]?.src === media[m[k] ?? -1]?.src)) e.forEach((ei, k) => (out[ei] = m[k] ?? null));
		else fallback.push(tag);
	}
	if (!fallback.length) return out;
	const keys = media.map((m) => ({ tag: m.tag, id: null, identity: mediaIdentity(m.tag, m.src, base) }));
	const matched = correspond(els, keys);
	els.forEach((e, i) => {
		const j = matched[i];
		if (fallback.includes(e.tag) && j !== null && j !== undefined && media[j]?.tag === e.tag) out[i] = j;
	});
	return out;
}

// The layer's elements that reserve no box. `measured[i]` is the media entry of element i, or null when none is
// established; `media` is null when the recording has no media list.
function unsized(els: MediaElement[], measured: (number | null)[], media: RenderedMedia[] | null): Unsized[] {
	const out: Unsized[] = [];
	els.forEach(({ tag, id, identity, src, attrs, ordinal }, index) => {
		const m = media?.[measured[index] ?? -1];
		const reserved = m ? m.aspectRatio !== "auto" && !(present(m.width) && present(m.height)) : undefined;
		const sized = present(attrs.width) && present(attrs.height);
		if (sized || /aspect-ratio\s*:/i.test(attrs.style ?? "") || reserved) return;
		const missing = ["width", "height"].filter((a) => !present(attrs[a]));
		const computed = !media
			? ""
			: reserved === false
				? ", and no stylesheet aspect-ratio in the rendered computed style"
				: "; the rendered computed style could not be matched to this element, so a stylesheet aspect-ratio was not checked";
		out.push({
			index,
			identity,
			locator: id ? `html:${tag}#${id}` : `html:${tag}:nth(${ordinal})`,
			observed: `<${tag}${src ? ` src="${src}"` : ""}> has no ${missing.join(" or ")} attribute and no inline aspect-ratio${computed}`,
		});
	});
	return out;
}

// Source-layer hit at a line of a file.
function at(file: SourceFile, offset: number, observed: string): Hit {
	return { url: file.path, locator: `line:${lineAt(file.text ?? "", offset)}`, layer: "source", observed };
}

function nextApp(ctx: RuleContext): { source: SourceEvidence; app: string; files: SourceFile[] } | null {
	const source = ctx.evidence.source;
	const app = nextAppDir(source);
	return source && app ? { source, app, files: appFiles(source, app).filter((f) => f.text !== null) } : null;
}

function metadataObjects(file: SourceFile): MetadataObject[] {
	return metadataExports(file).flatMap((e) => e.objects);
}

// FW-NEXT-04: a URL value that is neither absolute (`scheme:`) nor protocol-relative resolves against metadataBase.
function relativeUrls(text: string, o: MetadataObject): { offset: number; field: string; value: string }[] {
	const out: { offset: number; field: string; value: string }[] = [];
	const check = (field: string, value: string, offset: number) => {
		const s = stringValue(value);
		if (s !== null && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith("//")) out.push({ offset, field, value: s });
	};
	const alternates = childEntries(text, o.entries.find((e) => e.key === "alternates"));
	const canonical = alternates.find((e) => e.key === "canonical");
	if (canonical) check("alternates.canonical", canonical.value, canonical.valueOffset);
	for (const l of childEntries(text, alternates.find((e) => e.key === "languages"))) check(`alternates.languages.${l.key}`, l.value, l.valueOffset);
	const og = childEntries(text, o.entries.find((e) => e.key === "openGraph"));
	const ogUrl = og.find((e) => e.key === "url");
	if (ogUrl) check("openGraph.url", ogUrl.value, ogUrl.valueOffset);
	const images = og.find((e) => e.key === "images");
	const image = (value: string, offset: number) => {
		if (value.startsWith("{")) {
			const u = childEntries(text, { key: "", keyOffset: offset, value, valueOffset: offset }).find((e) => e.key === "url");
			if (u) check("openGraph.images", u.value, u.valueOffset);
		} else check("openGraph.images", value, offset);
	};
	if (images?.value.startsWith("[")) for (const el of arrayElements(text, images)) image(el.value, el.offset);
	else if (images) image(images.value, images.valueOffset);
	return out;
}

// Hosts that are not a production origin: loopback and localhost, and the preview-deployment domains of Vercel,
// Netlify and Cloudflare Pages, or a host whose first label starts with `preview`/`deploy-preview`. The list is this
// module's reading of "localhost or a preview host" in rules.md FW-NEXT-04; other staging hosts are not recognised.
function previewHost(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		/^127\./.test(host) ||
		host === "0.0.0.0" ||
		host === "[::1]" ||
		/\.(vercel\.app|netlify\.app|pages\.dev)$/.test(host) ||
		/^(deploy-)?preview\b/.test(host)
	);
}

export const rules: Record<string, Check> = {
	"CWV-001": field("largest_contentful_paint", 2500, 4000),
	"CWV-001b": field("largest_contentful_paint", 4000, null),
	"CWV-002": field("interaction_to_next_paint", 200, 500),
	"CWV-002b": field("interaction_to_next_paint", 500, null),
	"CWV-003": field("cumulative_layout_shift", 0.1, 0.25),
	"CWV-003b": field("cumulative_layout_shift", 0.25, null),

	"CWV-010": (ctx) =>
		ctx.audited.flatMap((p) => {
			if (p.crux?.scope) return [];
			const reason = p.crux?.reason ?? "no CrUX lookup";
			return [{ url: p.url, locator: "crux", layer: "field" as const, observed: reason.startsWith("field data unavailable") ? reason : `field data unavailable: ${reason}` }];
		}),

	"CWV-024": (ctx) =>
		ctx.audited.flatMap((p) =>
			(p.raw?.signals.scripts ?? []).flatMap((s) => {
				if (s.region !== "head" || s.src === null || s.attrs.async !== undefined || s.attrs.defer !== undefined || !CLASSIC_SCRIPT[s.type]) return [];
				return [{ url: p.fetch.finalUrl, locator: `html:script[src="${s.src}"]`, layer: "raw-html" as const, observed: `line ${s.line}: <script src="${s.src}"> in <head> without async or defer` }];
			}),
		),

	"CWV-040": (ctx) =>
		ctx.audited.flatMap((p) => {
			const media = p.rendered?.page.media ?? null;
			const rawEls = p.raw ? mediaElements(p.raw.signals, layerBase(p.raw.signals, p.fetch.finalUrl)) : [];
			const renBase = p.rendered ? layerBase(p.rendered.signals, p.rendered.page.finalUrl) : "";
			const renEls = p.rendered ? mediaElements(p.rendered.signals, renBase) : [];
			const renMeasured = media ? renderedMedia(renEls, media, renBase) : renEls.map(() => null);
			const rawToRen = correspond(rawEls, renEls);
			const renToRaw = correspond(renEls, rawEls);
			const raw = unsized(rawEls, rawToRen.map((i) => (i === null ? null : (renMeasured[i] ?? null))), media);
			const reported: Record<number, true> = Object.fromEntries(raw.map((u) => [u.index, true] as const));
			// Raw findings with no rendered counterpart, by source: a rendered element of that source whose own raw
			// counterpart is equally unestablished is one of them, already flagged, not a rendered-only element.
			const unmatchedRaw: Record<string, true> = Object.fromEntries(raw.filter((u) => rawToRen[u.index] === null).map((u) => [u.identity, true] as const));
			const rendered = unsized(renEls, renMeasured, media).filter((u) => {
				const r = renToRaw[u.index];
				return r === null || r === undefined ? !unmatchedRaw[u.identity] : !reported[r];
			});
			return [
				...raw.map((u): Hit => ({ url: p.fetch.finalUrl, locator: u.locator, layer: "raw-html", observed: u.observed })),
				...rendered.map((u): Hit => ({ url: p.fetch.finalUrl, locator: u.locator, layer: "rendered", observed: `${u.observed} (rendered DOM only)` })),
			];
		}),

	"LH-P01": metricOver("largest-contentful-paint", 2500, " ms"),
	"LH-P02": metricOver("cumulative-layout-shift", 0.1, ""),
	"LH-P05": insightFails("lcp-discovery-insight"),
	"LH-P06": insightFails("render-blocking-insight"),
	"LH-P09": insightFails("font-display-insight"),

	"FW-NEXT-01": (ctx) => {
		const next = nextApp(ctx);
		if (!next) return [];
		const out: Hit[] = [];
		for (const f of next.files.filter((x) => isPage(x.path))) {
			const layouts = ancestorLayouts(next.source, next.app, f.path);
			const titled = [f, ...layouts].some((x) =>
				metadataExports(x).some((e) => (e.kind === "metadata" ? e.objects.some((o) => o.entries.some((k) => k.key === "title")) : /\btitle\b/.test(e.body))),
			);
			if (!titled)
				out.push({
					url: f.path,
					locator: "doc",
					layer: "source",
					observed: `no metadata or generateMetadata with a title in ${f.path} or its layouts (${layouts.map((l) => l.path).join(", ") || "none"})`,
				});
		}
		for (const f of next.files.filter((x) => isPage(x.path) || isLayout(x.path))) {
			const ex = metadataExports(f);
			const both = ex.find((e) => e.kind === "generateMetadata");
			if (both && ex.some((e) => e.kind === "metadata")) out.push(at(f, both.offset, "exports both `metadata` and `generateMetadata`"));
		}
		return out;
	},

	"FW-NEXT-02": (ctx) =>
		(nextApp(ctx)?.files ?? []).flatMap((f) => {
			const first = metadataExports(f)[0];
			return first && isClientFile(f) ? [at(f, first.offset, `'use client' file exports \`${first.kind}\`, which only Server Components support`)] : [];
		}),

	"FW-NEXT-04": (ctx) => {
		const next = nextApp(ctx);
		if (!next) return [];
		const out: Hit[] = [];
		for (const f of next.files) {
			const text = f.text ?? "";
			const objects = metadataObjects(f);
			const based = [f, ...ancestorLayouts(next.source, next.app, f.path)].some((x) => metadataObjects(x).some((o) => o.entries.some((e) => e.key === "metadataBase")));
			for (const o of objects) {
				if (!based) for (const r of relativeUrls(text, o)) out.push(at(f, r.offset, `${r.field} is the relative URL "${r.value}" and no metadataBase is set`));
				const base = o.entries.find((e) => e.key === "metadataBase");
				const value = base ? urlValue(base.value) : null;
				if (base && value !== null && previewHost(value)) out.push(at(f, base.valueOffset, `metadataBase ${value} is not a production host`));
			}
		}
		return out;
	},

	"FW-NEXT-05": (ctx) =>
		(nextApp(ctx)?.files ?? []).flatMap((f) =>
			metadataObjects(f).flatMap((o) => {
				const title = childEntries(f.text ?? "", o.entries.find((e) => e.key === "title"));
				const template = title.find((e) => e.key === "template");
				if (!template) return [];
				if (!title.some((e) => e.key === "default")) return [at(f, template.keyOffset, "title.template without title.default")];
				return isPage(f.path) ? [at(f, template.keyOffset, "title.template exported from a page, where it has no effect")] : [];
			}),
		),

	"FW-NEXT-23": (ctx) =>
		(nextApp(ctx)?.files ?? []).flatMap((f) =>
			metadataObjects(f)
				.filter((o) => o.via === "metadata")
				.flatMap((o) => o.entries.filter((e: Entry) => e.key === "viewport" || e.key === "themeColor"))
				.map((e) => at(f, e.keyOffset, `\`${e.key}\` inside the exported metadata object (deprecated since Next.js 14)`)),
		),

	"FW-VITE-07": (ctx) => {
		const index = viteSpaIndex(ctx.evidence.source);
		if (!index) return [];
		return scanHead(index.text ?? "")
			.tags.filter((t) => t.name === "link" && (t.attrs.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))
			.map((t) => ({ url: index.path, locator: `line:${t.line}`, layer: "source" as const, observed: `<link rel="canonical" href="${t.attrs.href ?? ""}"> in the SPA's shared index.html` }));
	},
};

export const notes: Record<string, Check> = {
	// A server redirect that changes the path is a legitimate move, not a sneaky redirect (spam-policies). One note per
	// audited URL, at its first path-changing hop, covering the whole chain.
	"DNF-18": (ctx) =>
		ctx.audited.flatMap((p) => {
			const moves = p.fetch.hops.flatMap((h, i) => {
				const to = REDIRECT[h.status] && h.location ? normaliseUrl(h.location, h.url) : null;
				return to ? [{ i, status: h.status, from: new URL(h.url).pathname, to: new URL(to).pathname }] : [];
			});
			const first = moves.find((m) => m.from !== m.to);
			if (!first) return [];
			const chain =
				moves.length === 1
					? `${first.status} ${first.from} -> ${first.to}`
					: `${moves.length} redirects ${moves[0]?.from ?? first.from} -> ${moves.at(-1)?.to ?? first.to}`;
			return [
				{
					url: p.url,
					locator: `hop:${first.i + 1}`,
					layer: "headers" as const,
					observed: `${chain}: a server redirect every client sees, not reported as a sneaky redirect`,
				},
			];
		}),

	"FW-DNF-11": (ctx) =>
		(nextApp(ctx)?.files ?? [])
			.filter((f) => isPage(f.path) || isLayout(f.path))
			.flatMap((f) =>
				[...(f.text ?? "").matchAll(/<script\b[^>]*\btype\s*=\s*\{?\s*["'`]application\/ld\+json["'`]/g)].map((m) =>
					at(f, m.index, 'native <script type="application/ld+json"> (next/script is not required for JSON-LD)'),
				),
			),

	"FW-DNF-12": (ctx) =>
		(nextApp(ctx)?.files ?? []).flatMap((f) => {
			const text = f.text ?? "";
			const imported = new Set(
				[...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']next\/navigation["']/g)].flatMap((m) =>
					(m[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/).pop() ?? ""),
				),
			);
			return [...text.matchAll(/\b(redirect|permanentRedirect)\s*\(\s*([^)]*)\)/g)]
				.filter((m) => imported.has(m[1] ?? ""))
				.map((m) =>
					at(f, m.index, `${m[1]}(${(m[2] ?? "").trim()}) answers ${m[1] === "redirect" ? "307" : "308"}: Next's ${m[1] === "redirect" ? "temporary" : "permanent"} redirect, not flagged for not being ${m[1] === "redirect" ? "302" : "301"}`),
				);
		}),
};
