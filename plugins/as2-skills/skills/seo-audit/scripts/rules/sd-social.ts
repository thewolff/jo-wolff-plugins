// Structured-data and social rule family: rules.md categories structured-data and social, plus the do-not-flag
// notes SD-JLD-07, NF-01, NF-02, NF-06, NF-07, NF-10 and DNF-21.
//
// The structured-data view of a page is its rendered layer's JSON-LD when the page was rendered (what Google
// processes after rendering), else the raw layer's. Locators: `jsonld:nth(N)` is the Nth JSON-LD block (1-based) of
// the emitting layer, `jsonld:nth(N)<path>` a node or value inside it with a jsonld.ts JSON path.
import type { Check, Hit, RuleContext } from "../lib/engine.ts";
import { declaredCanonicals, type LayerEvidence, type PageEvidence } from "../lib/evidence.ts";
import { scanHead } from "../lib/html.ts";
import type { Json, JsonLdBlock, JsonLdEvidence, JsonLdNode } from "../lib/jsonld.ts";
import { robotsVerdict } from "../lib/robots.ts";
import { scanJsonSource } from "../lib/sd-social-json.ts";
import {
	APP_CATEGORIES,
	APP_TYPES,
	ARTICLE_TYPES,
	inScope,
	isObject,
	isReference,
	items,
	type JsonObject,
	normaliseType,
	ORGANIZATION_TYPES,
	present,
	REQUIRED,
} from "../lib/sd-social-types.ts";
import { clip, normaliseUrl, pathOf } from "../lib/url.ts";

const MB = 1048576;

interface View {
	layer: "raw" | "rendered";
	jsonld: JsonLdEvidence;
}

interface TypedNode extends JsonLdNode {
	n: number; // 1-based block number
	normTypes: string[];
}

function view(p: PageEvidence): View | null {
	if (p.rendered) return { layer: "rendered", jsonld: p.rendered.jsonld };
	if (p.raw) return { layer: "raw", jsonld: p.raw.jsonld };
	return null;
}

const loc = (n: number, path = ""): string => `jsonld:nth(${n})${path}`;

// Every audited page with a structured-data view, with its typed nodes; the shape most structured-data rules share.
function sdPages(ctx: RuleContext, each: (p: PageEvidence, nodes: TypedNode[], v: View) => Hit[]): Hit[] {
	return ctx.audited.flatMap((p) => {
		const v = view(p);
		return v ? each(p, v.jsonld.nodes.map((nd) => ({ ...nd, n: nd.block + 1, normTypes: nd.types.map(normaliseType) })), v) : [];
	});
}

function nodeHits(ctx: RuleContext, test: (nd: TypedNode, p: PageEvidence) => string | null): Hit[] {
	return sdPages(ctx, (p, nodes) =>
		nodes.flatMap((nd) => {
			const observed = test(nd, p);
			return observed === null ? [] : [{ url: p.fetch.finalUrl, locator: loc(nd.n, nd.path), layer: "structured-data" as const, observed }];
		}),
	);
}

// Calls `visit` for every object reachable from an in-scope node without crossing into another in-scope typed node
// (that node is visited on its own), so each value belongs to exactly one in-scope node.
function scopeObjects(nd: TypedNode, visit: (obj: JsonObject, path: string) => void): void {
	const go = (v: Json, path: string, root: boolean): void => {
		if (Array.isArray(v)) {
			v.forEach((x, i) => go(x, `${path}[${i}]`, false));
			return;
		}
		if (!isObject(v)) return;
		if (!root && v["@type"] !== undefined && inScope(items(v["@type"]).filter((t): t is string => typeof t === "string").map(normaliseType))) return;
		visit(v, path);
		for (const [k, child] of Object.entries(v)) if (k !== "@context") go(child, `${path}[${JSON.stringify(k)}]`, false);
	};
	go(nd.node, nd.path, true);
}

function isSchemaContext(v: Json | undefined): boolean {
	if (typeof v === "string") return /^https?:\/\/schema\.org\/?$/i.test(v.trim());
	if (Array.isArray(v)) return v.some((x) => isSchemaContext(x));
	return isObject(v) && typeof v["@vocab"] === "string" && /^https?:\/\/schema\.org\/?$/i.test(v["@vocab"].trim());
}

// SD-JLD-04: problems of top-level items and `@graph` members.
function topLevelProblems(v: Json, path: string, contextOk: boolean, out: { path: string; problems: string[] }[]): void {
	if (Array.isArray(v)) {
		v.forEach((x, i) => topLevelProblems(x, `${path}[${i}]`, contextOk, out));
		return;
	}
	if (!isObject(v)) {
		out.push({ path, problems: [`top-level item is ${v === null ? "null" : typeof v}, not an object`] });
		return;
	}
	const ctxOk = contextOk || isSchemaContext(v["@context"]);
	const problems: string[] = [];
	if (!ctxOk) problems.push(`no schema.org @context (${v["@context"] === undefined ? "absent" : JSON.stringify(v["@context"])})`);
	if (v["@graph"] !== undefined) {
		if (problems.length) out.push({ path, problems });
		const g = v["@graph"];
		if (Array.isArray(g)) g.forEach((m, i) => topLevelProblems(m, `${path}["@graph"][${i}]`, ctxOk, out));
		else topLevelProblems(g, `${path}["@graph"]`, ctxOk, out);
		return;
	}
	if (v["@type"] === undefined) problems.push("no @type");
	if (problems.length) out.push({ path, problems });
}

const productKey = (nd: JsonLdNode): string =>
	typeof nd.node["@id"] === "string" ? `@id ${nd.node["@id"]}` : typeof nd.node.name === "string" ? `name ${nd.node.name}` : JSON.stringify(nd.node);

const isProduct = (nd: JsonLdNode): boolean => nd.types.map(normaliseType).includes("Product");

const isSiteRoot = (u: string): boolean => {
	const url = new URL(u);
	return url.pathname === "/" && url.search === "";
};

const nameOf = (v: Json | undefined): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : null);

// ---- social helpers ---------------------------------------------------------------------------------------------

interface SocialMeta {
	name: string;
	key: string;
	content: string;
	line: number;
}

// `og:` and `twitter:` metas, whether keyed by `property` or `name` (consumers accept both), anywhere in the document.
function socialMetas(layer: LayerEvidence): SocialMeta[] {
	return layer.signals.metas
		.filter((m) => (m.key === "property" || m.key === "name") && (m.name.startsWith("og:") || m.name.startsWith("twitter:")))
		.map((m) => ({ name: m.name, key: m.key, content: m.content.trim(), line: m.line }));
}

function firstMeta(ms: SocialMeta[], name: string): SocialMeta | undefined {
	return ms.find((m) => m.name === name && m.content !== "");
}

const metaLoc = (m: { name: string }): string => `html:meta[${m.name.startsWith("og:") ? "property" : "name"}=${m.name}]`;

function socialHits(ctx: RuleContext, each: (ms: SocialMeta[], p: PageEvidence) => { locator: string; observed: string }[]): Hit[] {
	return ctx.audited.flatMap((p) => {
		if (!p.raw) return [];
		return each(socialMetas(p.raw), p).map((h) => ({ url: p.fetch.finalUrl, layer: "raw-html" as const, ...h }));
	});
}

function tooLong(ctx: RuleContext, name: string, max: number): Hit[] {
	return socialHits(ctx, (ms) => {
		const m = firstMeta(ms, name);
		const length = m ? [...m.content].length : 0; // code points, not UTF-16 units
		return m && length > max ? [{ locator: metaLoc(m), observed: `${name} is ${length} characters (line ${m.line}): ${clip(m.content, 120)}` }] : [];
	});
}

const OG_TYPES: Record<string, true> = { website: true, article: true, book: true, profile: true };
const CARDS: Record<string, true> = { summary: true, summary_large_image: true, app: true, player: true };
const OG_REQUIRED = ["og:title", "og:type", "og:image", "og:url"];

export const rules: Record<string, Check> = {
	"SD-GEN-06": (ctx) =>
		sdPages(ctx, (p, nodes) =>
			nodes.flatMap((nd) =>
				nd.normTypes.flatMap((t) =>
					(REQUIRED[t] ?? [])
						.filter((r) => !r.met(nd.node, !nd.topLevel))
						.map((r) => ({
							url: p.fetch.finalUrl,
							locator: `${loc(nd.n, nd.path)} ${t}.${r.property}`,
							layer: "structured-data" as const,
							observed: `${t} node lacks ${r.property}`,
						})),
				),
			),
		),

	"SD-GEN-08": (ctx) =>
		ctx.audited.flatMap((p) => {
			if (!p.raw || !p.rendered) return [];
			const rawKeys = new Set(p.raw.jsonld.nodes.filter(isProduct).map(productKey));
			return p.rendered.jsonld.nodes
				.filter((nd) => isProduct(nd) && !rawKeys.has(productKey(nd)))
				.map((nd) => ({
					url: p.fetch.finalUrl,
					locator: loc(nd.block + 1, nd.path),
					layer: "rendered" as const,
					observed: `Product (${clip(productKey(nd), 120)}) is in the rendered DOM only; the raw HTML has no such Product node`,
				}));
		}),

	"SD-GEN-11": (ctx) =>
		sdPages(ctx, (p, nodes) => {
			const origin = new URL(p.fetch.finalUrl).origin;
			const parsed = ctx.site(p.fetch.finalUrl)?.robots.parsed;
			if (!parsed) return [];
			const seen = new Set<string>();
			const hits: Hit[] = [];
			for (const nd of nodes.filter((x) => inScope(x.normTypes))) {
				scopeObjects(nd, (obj, path) => {
					for (const key of ["image", "logo", "thumbnailUrl"]) {
						for (const v of items(obj[key])) {
							const ref = typeof v === "string" ? v : isObject(v) ? (typeof v.url === "string" ? v.url : typeof v.contentUrl === "string" ? v.contentUrl : null) : null;
							const u = ref ? normaliseUrl(ref.trim(), p.fetch.finalUrl) : null;
							if (!u || new URL(u).origin !== origin) continue;
							const verdict = robotsVerdict(parsed, ["Googlebot-Image", "Googlebot"], pathOf(u));
							const locator = `url:${pathOf(u)}`;
							if (verdict.allowed || seen.has(locator)) continue;
							seen.add(locator);
							hits.push({
								url: p.fetch.finalUrl,
								locator,
								layer: "robots",
								observed: `${key} at ${loc(nd.n, path)} is disallowed for ${verdict.group} by robots.txt line ${verdict.rule?.line} (Disallow: ${verdict.rule?.path})`,
							});
						}
					}
				});
			}
			return hits;
		}),

	"SD-SW-04": (ctx) =>
		sdPages(ctx, (p, nodes) =>
			nodes
				.filter((nd) => nd.normTypes.some((t) => APP_TYPES[t]))
				.flatMap((nd) =>
					items(nd.node.applicationCategory)
						.filter((c): c is string => typeof c === "string")
						.filter((c) => !APP_CATEGORIES[normaliseType(c)])
						.map((c) => ({
							url: p.fetch.finalUrl,
							locator: loc(nd.n, `${nd.path}["applicationCategory"]`),
							layer: "structured-data" as const,
							observed: `applicationCategory "${clip(c, 100)}" is not a supported app type`,
						})),
				),
		),

	"SD-SW-06": (ctx) =>
		sdPages(ctx, (p, nodes) =>
			nodes
				.filter((nd) => nd.normTypes.some((t) => APP_TYPES[t]))
				.flatMap((nd) => {
					const offers = nd.node.offers;
					return items(offers).flatMap((o, i) => {
						if (!isObject(o) || present(o.priceCurrency)) return [];
						const price = typeof o.price === "number" ? o.price : typeof o.price === "string" ? Number.parseFloat(o.price) : Number.NaN;
						if (!(price > 0)) return [];
						return [
							{
								url: p.fetch.finalUrl,
								locator: loc(nd.n, `${nd.path}["offers"]${Array.isArray(offers) ? `[${i}]` : ""}`),
								layer: "structured-data" as const,
								observed: `offers.price ${JSON.stringify(o.price)} with no priceCurrency`,
							},
						];
					});
				}),
		),

	"SD-SW-09": (ctx) => nodeHits(ctx, (nd) => (nd.normTypes.length === 1 && nd.normTypes[0] === "VideoGame" ? `@type is ${JSON.stringify(nd.node["@type"])} alone` : null)),

	"SD-REV-05": (ctx) =>
		nodeHits(ctx, (nd) => {
			const reviews = nd.node.review;
			return Array.isArray(reviews) && reviews.length >= 2 && !present(nd.node.aggregateRating) ? `${reviews.length} review entries and no aggregateRating` : null;
		}),

	"SD-REV-08": (ctx) =>
		nodeHits(ctx, (nd) => {
			if (!nd.normTypes.some((t) => ORGANIZATION_TYPES[t])) return null;
			const self = typeof nd.node["@id"] === "string" ? nd.node["@id"] : null;
			const about = ["review", "aggregateRating"].filter((k) =>
				items(nd.node[k]).some((x) => {
					if (!isObject(x) || isReference(x)) return false;
					const target = x.itemReviewed;
					if (!present(target)) return true;
					return self !== null && isObject(target) && target["@id"] === self;
				}),
			);
			return about.length ? `${nd.normTypes.join("/")} "${clip(nameOf(nd.node.name) ?? "", 80)}" carries ${about.join(" and ")} about itself` : null;
		}),

	"SD-ORG-04": (ctx) =>
		sdPages(ctx, (p, nodes) => {
			if (!isSiteRoot(p.fetch.finalUrl)) return [];
			const siteNames = [...new Set(nodes.filter((nd) => nd.normTypes.includes("WebSite")).flatMap((nd) => nameOf(nd.node.name) ?? []))];
			if (!siteNames.length) return [];
			return nodes
				.filter((nd) => nd.normTypes.some((t) => ORGANIZATION_TYPES[t]))
				.flatMap((nd) => {
					const name = nameOf(nd.node.name);
					const differs = siteNames.filter((s) => s !== name);
					return name && differs.length
						? [{ url: p.fetch.finalUrl, locator: loc(nd.n, nd.path), layer: "structured-data" as const, observed: `Organization name "${name}" differs from WebSite name ${differs.map((s) => `"${s}"`).join(", ")}` }]
						: [];
				});
		}),

	"SD-WEB-04": (ctx) =>
		sdPages(ctx, (p, nodes) => {
			if (!isSiteRoot(p.fetch.finalUrl)) return [];
			const sites = nodes.filter((nd) => nd.normTypes.includes("WebSite"));
			const second = sites[1];
			return second ? [{ url: p.fetch.finalUrl, locator: loc(second.n, second.path), layer: "structured-data" as const, observed: `${sites.length} WebSite nodes on the site root` }] : [];
		}),

	"SD-BC-01": (ctx) =>
		nodeHits(ctx, (nd) => {
			if (!nd.normTypes.includes("BreadcrumbList")) return null;
			const count = items(nd.node.itemListElement).length;
			return count < 2 ? `BreadcrumbList with ${count} itemListElement ${count === 1 ? "entry" : "entries"}` : null;
		}),

	"SD-JLD-01": (ctx) =>
		ctx.audited.flatMap((p) => {
			if (!p.raw) return [];
			const raw = p.raw.jsonld.blocks;
			const hit = (b: JsonLdBlock, layer: "raw-html" | "rendered"): Hit => ({
				url: p.fetch.finalUrl,
				locator: loc(b.index + 1),
				layer,
				observed: `line ${b.line}: ${clip(b.error ?? "", 160)}`,
			});
			const rawTexts = new Set(raw.map((b) => b.raw.trim()));
			return [
				...raw.filter((b) => b.error).map((b) => hit(b, "raw-html")),
				...(p.rendered?.jsonld.blocks ?? []).filter((b) => b.error && !rawTexts.has(b.raw.trim())).map((b) => hit(b, "rendered")),
			];
		}),

	"SD-JLD-02": (ctx) =>
		ctx.audited.flatMap((p) =>
			(p.raw?.jsonld.blocks ?? []).flatMap((b) => {
				const { comments } = scanJsonSource(b.raw);
				const first = comments[0];
				return first
					? [{ url: p.fetch.finalUrl, locator: loc(b.index + 1), layer: "raw-html" as const, observed: `${comments.length} comment(s), first at line ${b.line + first.line - 1}: ${clip(first.text, 80)}` }]
					: [];
			}),
		),

	"SD-JLD-03": (ctx) =>
		ctx.audited.flatMap((p) =>
			(p.raw?.jsonld.blocks ?? []).flatMap((b) =>
				scanJsonSource(b.raw).duplicates.map((d) => ({
					url: p.fetch.finalUrl,
					locator: loc(b.index + 1, `${d.path}[${JSON.stringify(d.key)}]`),
					layer: "raw-html" as const,
					observed: `key ${JSON.stringify(d.key)} defined again at line ${b.line + d.line - 1}`,
				})),
			),
		),

	"SD-JLD-04": (ctx) =>
		sdPages(ctx, (p, _nodes, v) =>
			v.jsonld.blocks.flatMap((b) => {
				if (b.parsed === undefined) return [];
				const out: { path: string; problems: string[] }[] = [];
				topLevelProblems(b.parsed, "$", false, out);
				return out.map((o) => ({ url: p.fetch.finalUrl, locator: loc(b.index + 1, o.path), layer: "structured-data" as const, observed: o.problems.join("; ") }));
			}),
		),

	"SD-JLD-06": (ctx) =>
		sdPages(ctx, (p, nodes) => {
			const hits = new Map<string, Hit>();
			for (const nd of nodes.filter((x) => inScope(x.normTypes))) {
				scopeObjects(nd, (obj, path) => {
					for (const key of ["price", "ratingValue", "ratingCount", "reviewCount"]) {
						const v = obj[key];
						if (v === undefined || typeof v === "number" || (typeof v === "string" && /^-?(\d+(\.\d*)?|\.\d+)$/.test(v.trim()))) continue;
						const locator = loc(nd.n, `${path}[${JSON.stringify(key)}]`);
						hits.set(locator, { url: p.fetch.finalUrl, locator, layer: "structured-data", observed: `${key} is ${clip(JSON.stringify(v), 80)}, not a number` });
					}
				});
			}
			return [...hits.values()];
		}),

	"OG-01": (ctx) =>
		socialHits(ctx, (ms) => {
			if (!ms.some((m) => m.name.startsWith("og:"))) return [];
			return OG_REQUIRED.filter((name) => !firstMeta(ms, name)).map((name) => ({ locator: metaLoc({ name }), observed: `${name} missing; present: ${[...new Set(ms.filter((m) => m.name.startsWith("og:")).map((m) => m.name))].join(", ")}` }));
		}),

	"OG-02": (ctx) =>
		socialHits(ctx, (ms, p) => {
			const og = firstMeta(ms, "og:url");
			const canonical = declaredCanonicals(p).find((c) => c.resolved !== null);
			if (!og || !canonical?.resolved) return [];
			const ogUrl = normaliseUrl(og.content, p.fetch.finalUrl);
			return ogUrl !== canonical.resolved ? [{ locator: metaLoc(og), observed: `og:url ${clip(og.content, 120)} (line ${og.line}) differs from canonical ${clip(canonical.resolved, 120)}` }] : [];
		}),

	"OG-03": (ctx) =>
		socialHits(ctx, (ms) => {
			const m = firstMeta(ms, "og:type");
			if (!m) return [];
			const v = m.content.toLowerCase();
			const ok = OG_TYPES[v] || v.startsWith("music.") || v.startsWith("video.") || v.includes(":");
			return ok ? [] : [{ locator: metaLoc(m), observed: `og:type "${clip(m.content, 80)}" (line ${m.line})` }];
		}),

	"OG-04": (ctx) =>
		socialHits(ctx, (ms) => {
			const img = firstMeta(ms, "og:image");
			return img && !firstMeta(ms, "og:image:alt") ? [{ locator: metaLoc(img), observed: `og:image at line ${img.line} has no og:image:alt` }] : [];
		}),

	"OG-08": (ctx) =>
		socialHits(ctx, (ms) =>
			["og:title", "og:type", "og:url", "og:description"].flatMap((name) => {
				const values = ms.filter((m) => m.name === name);
				const distinct = [...new Set(values.map((m) => m.content))];
				return distinct.length > 1 ? [{ locator: metaLoc({ name }), observed: `${name} given ${values.length} times (lines ${values.map((m) => m.line).join(", ")}): ${distinct.map((d) => `"${clip(d, 60)}"`).join(" vs ")}` }] : [];
			}),
		),

	"TW-01": (ctx) =>
		socialHits(ctx, (ms) => {
			const m = firstMeta(ms, "twitter:card");
			return m && !CARDS[m.content.toLowerCase()] ? [{ locator: metaLoc(m), observed: `twitter:card "${clip(m.content, 80)}" (line ${m.line})` }] : [];
		}),

	"TW-02": (ctx) =>
		socialHits(ctx, (ms) => {
			const m = firstMeta(ms, "twitter:card");
			return m?.content.toLowerCase() === "summary_large_image" && !firstMeta(ms, "twitter:title") && !firstMeta(ms, "og:title")
				? [{ locator: metaLoc(m), observed: `summary_large_image card (line ${m.line}) with neither twitter:title nor og:title` }]
				: [];
		}),

	"TW-04": (ctx) => tooLong(ctx, "twitter:description", 200),
	"TW-04b": (ctx) => tooLong(ctx, "twitter:title", 70),
	"TW-06": (ctx) => tooLong(ctx, "twitter:image:alt", 420),

	"AI-076": (ctx) =>
		ctx.audited.flatMap((p) => {
			const html = p.raw?.html;
			if (!html || Buffer.byteLength(html) <= MB) return [];
			const tag = scanHead(html).tags.find(
				(t) => t.name === "meta" && ((t.attrs.property ?? t.attrs.name ?? "").toLowerCase().startsWith("og:")) && Buffer.byteLength(html.slice(0, t.offset)) >= MB,
			);
			if (!tag) return [];
			const name = (tag.attrs.property ?? tag.attrs.name ?? "").toLowerCase();
			return [{ url: p.fetch.finalUrl, locator: metaLoc({ name }), layer: "raw-html" as const, observed: `${name} starts at byte ${Buffer.byteLength(html.slice(0, tag.offset))} (line ${tag.line}), past the first 1,048,576 bytes` }];
		}),
};

// ---- do-not-flag notes ------------------------------------------------------------------------------------------

function docNote(ctx: RuleContext, test: (nodes: TypedNode[]) => string | null): Hit[] {
	return sdPages(ctx, (p, nodes) => {
		if (!nodes.some((nd) => nd.normTypes.length)) return [];
		const observed = test(nodes);
		return observed === null ? [] : [{ url: p.fetch.finalUrl, locator: "doc", layer: "structured-data" as const, observed }];
	});
}

const typeList = (nodes: TypedNode[]): string => [...new Set(nodes.flatMap((nd) => nd.normTypes))].join(", ");

export const notes: Record<string, Check> = {
	// Several JSON-LD blocks, or one @graph, are equally valid.
	"SD-JLD-07": (ctx) =>
		sdPages(ctx, (p, _nodes, v) => {
			const parsed = v.jsonld.blocks.filter((b) => b.parsed !== undefined);
			return parsed.length >= 2 ? [{ url: p.fetch.finalUrl, locator: "doc", layer: "structured-data" as const, observed: `${parsed.length} JSON-LD blocks in the ${v.layer} layer` }] : [];
		}),

	"NF-01": (ctx) => docNote(ctx, (nodes) => (nodes.some((nd) => nd.normTypes.some((t) => t === "FAQPage" || t === "HowTo")) ? null : `no FAQPage or HowTo markup; types: ${typeList(nodes)}`)),

	"NF-02": (ctx) =>
		nodeHits(ctx, (nd) => {
			if (!nd.normTypes.includes("WebSite")) return null;
			const search = items(nd.node.potentialAction).some((a) => isObject(a) && items(a["@type"]).some((t) => typeof t === "string" && normaliseType(t) === "SearchAction"));
			return search ? "WebSite carries a SearchAction potentialAction (no longer used, harmless)" : "WebSite without a SearchAction potentialAction";
		}),

	"NF-07": (ctx) =>
		docNote(ctx, (nodes) => (nodes.some((nd) => nd.normTypes.some((t) => ORGANIZATION_TYPES[t] || ARTICLE_TYPES[t])) ? null : `no Organization or Article markup; types: ${typeList(nodes)}`)),

	"NF-10": (ctx) => docNote(ctx, (nodes) => (nodes.some((nd) => nd.normTypes.includes("BreadcrumbList")) ? null : `no BreadcrumbList markup; types: ${typeList(nodes)}`)),

	// JSON-LD added by JavaScript (other than Product, which SD-GEN-08 covers) is read by Google after rendering.
	"NF-06": (ctx) =>
		ctx.audited.flatMap((p) => {
			if (!p.raw || !p.rendered) return [];
			const rawBlocks = new Set(p.raw.jsonld.blocks.flatMap((b) => (b.parsed === undefined ? [] : [JSON.stringify(b.parsed)])));
			return p.rendered.jsonld.blocks.flatMap((b) => {
				if (b.parsed === undefined || rawBlocks.has(JSON.stringify(b.parsed))) return [];
				const nodes = p.rendered?.jsonld.nodes.filter((nd) => nd.block === b.index) ?? [];
				if (!nodes.length || nodes.some(isProduct)) return []; // a block carrying Product is SD-GEN-08's case
				const types = [...new Set(nodes.flatMap((nd) => nd.types.map(normaliseType)))].join(", ");
				return [{ url: p.fetch.finalUrl, locator: loc(b.index + 1), layer: "rendered" as const, observed: `JSON-LD block (${types}) added by JavaScript` }];
			});
		}),

	// A client-rendered body under a server-set head is fine: Google renders the page.
	"DNF-21": (ctx) =>
		ctx.audited.flatMap((p) => {
			if (!p.raw || !p.rendered || p.rendered.page.error) return [];
			if (normaliseUrl(p.rendered.page.finalUrl) !== normaliseUrl(p.fetch.finalUrl)) return [];
			if (!p.raw.signals.titles.some((t) => t.region === "head" && t.text.trim())) return [];
			const rawH1 = new Set(p.raw.signals.headings.filter((h) => h.level === 1).map((h) => h.text.trim()));
			const newH1 = p.rendered.signals.headings.filter((h) => h.level === 1 && h.text.trim() && !rawH1.has(h.text.trim()));
			const added = p.rendered.signals.mainText.length - p.raw.signals.mainText.length;
			if (!newH1.length && added <= 200) return [];
			return [
				{
					url: p.fetch.finalUrl,
					locator: "html:body",
					layer: "rendered" as const,
					observed: `head title set in the raw HTML; JavaScript adds ${added} characters of body text${newH1.length ? ` and h1 "${clip(newH1[0]?.text.trim() ?? "", 80)}"` : ""}`,
				},
			];
		}),
};
