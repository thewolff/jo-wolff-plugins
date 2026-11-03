// HTML evidence: a hand-written tag scanner with Google's head-order rule ("If you use an invalid element in the
// <head> element, Google ignores any elements that appear after the invalid element", rules.md CAN-014), and Bun's
// HTMLRewriter for body content (links, images, headings, data-nosnippet nodes, text). Both layers, raw HTML and the
// rendered DOM, go through the same extraction so rules compare like with like.

const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	copy: "©",
	reg: "®",
	hellip: "…",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	middot: "·",
	bull: "•",
	laquo: "«",
	raquo: "»",
};

export function decodeHtml(s: string): string {
	return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (m, ref: string) => {
		if (ref.startsWith("#")) {
			const cp = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
			return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
		}
		return NAMED[ref] ?? m;
	});
}

export interface Tag {
	name: string; // lowercased
	attrs: Record<string, string>; // names lowercased, values entity-decoded; first occurrence wins
	attrOrder: string[];
	line: number;
	offset: number;
	text: string; // decoded content of title/script/style/textarea/noscript, "" otherwise
	region: "head" | "body";
}

// Elements Google accepts in <head> (rules.md CAN-014).
export const VALID_HEAD: Record<string, true> = {
	title: true,
	meta: true,
	link: true,
	script: true,
	style: true,
	base: true,
	noscript: true,
	template: true,
};
const RAW_TEXT: Record<string, true> = {
	script: true,
	style: true,
	title: true,
	textarea: true,
	noscript: true,
	iframe: true,
	xmp: true,
	noembed: true,
	noframes: true,
};

export interface HeadScan {
	tags: Tag[]; // every start tag in document order, with its region
	invalid: Tag | null; // the first invalid element that ended <head>
	ignoredAfterInvalid: Tag[]; // head-valid elements after it, which Google ignores
	headEnd: { reason: "end-tag" | "body" | "invalid-element" | "text" | "eof"; line: number };
}

// Scans start tags in order and assigns each to head or body the way a parser closes <head>: at </head> followed by
// body content, <body>, the first element that is not valid in head, or non-whitespace text.
export function scanHead(html: string): HeadScan {
	const tags: Tag[] = [];
	// Widened on purpose: `endHead` sets "body" from a closure, which control-flow narrowing does not see.
	let state = "before" as "before" | "in" | "after" | "body";
	let invalid: Tag | null = null;
	let headEnd: HeadScan["headEnd"] = { reason: "eof", line: 0 };
	let i = 0;
	let line = 1;
	const advance = (to: number) => {
		for (let k = i; k < to; k++) if (html.charCodeAt(k) === 10) line++;
		i = to;
	};
	// The first literal </head> or <body> after the invalid element: what the author meant as head ends there.
	let authorHeadClose = Number.POSITIVE_INFINITY;
	const lower = html.toLowerCase();
	const endHead = (reason: HeadScan["headEnd"]["reason"], at: number) => {
		if (state === "body") return;
		if (state !== "after") headEnd = { reason, line: at };
		state = "body";
	};
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		const text = html.slice(i, lt < 0 ? html.length : lt);
		if (text.trim() && state !== "body") endHead("text", line);
		advance(lt < 0 ? html.length : lt);
		if (lt < 0) break;
		if (html.startsWith("<!--", i)) {
			const end = html.indexOf("-->", i + 4);
			advance(end < 0 ? html.length : end + 3);
			continue;
		}
		if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
			const end = html.indexOf(">", i);
			advance(end < 0 ? html.length : end + 1);
			continue;
		}
		const m = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(i, i + 64));
		if (!m) {
			if (state !== "body") endHead("text", line);
			advance(i + 1);
			continue;
		}
		const closing = m[1] === "/";
		const name = (m[2] ?? "").toLowerCase();
		const startLine = line;
		const offset = i;
		// Attributes up to the closing '>' (quotes respected).
		let j = i + m[0].length;
		const attrs: Record<string, string> = {};
		const attrOrder: string[] = [];
		while (j < html.length) {
			while (j < html.length && /[\s/]/.test(html[j] ?? "")) j++;
			if (j >= html.length || html[j] === ">") break;
			const an = /^[^\s"'>/=]+/.exec(html.slice(j, j + 256));
			if (!an) {
				j++;
				continue;
			}
			j += an[0].length;
			while (/\s/.test(html[j] ?? "")) j++;
			let value = "";
			if (html[j] === "=") {
				j++;
				while (/\s/.test(html[j] ?? "")) j++;
				const q = html[j];
				if (q === '"' || q === "'") {
					const end = html.indexOf(q, j + 1);
					value = html.slice(j + 1, end < 0 ? html.length : end);
					j = end < 0 ? html.length : end + 1;
				} else {
					const uv = /^[^\s>]*/.exec(html.slice(j, j + 4096));
					value = uv?.[0] ?? "";
					j += value.length;
				}
			}
			const key = an[0].toLowerCase();
			if (!(key in attrs)) {
				attrs[key] = decodeHtml(value);
				attrOrder.push(key);
			}
		}
		advance(Math.min(j + 1, html.length));
		if (closing) {
			if (name === "head") {
				if (invalid && authorHeadClose === Number.POSITIVE_INFINITY) authorHeadClose = offset;
				if (state === "in" || state === "before") {
					state = "after";
					headEnd = { reason: "end-tag", line: startLine };
				}
			}
			if (name === "body" || name === "html") endHead("body", startLine);
			continue;
		}
		let content = "";
		if (RAW_TEXT[name]) {
			const end = lower.indexOf(`</${name}`, i);
			const stop = end < 0 ? html.length : end;
			content = html.slice(i, stop);
			advance(stop);
			if (name === "title" || name === "textarea") content = decodeHtml(content);
		}
		if (name === "html") {
			tags.push({ name, attrs, attrOrder, line: startLine, offset, text: "", region: "head" });
			continue;
		}
		if (name === "head") {
			if (state === "before") state = "in";
			continue;
		}
		if (name === "body") {
			if (invalid && authorHeadClose === Number.POSITIVE_INFINITY) authorHeadClose = offset;
			endHead("body", startLine);
			tags.push({ name, attrs, attrOrder, line: startLine, offset, text: "", region: "body" });
			continue;
		}
		if (state !== "body") {
			if (VALID_HEAD[name]) {
				if (state === "before") state = "in";
			} else {
				if (state === "in" || state === "before") {
					invalid ??= { name, attrs, attrOrder, line: startLine, offset, text: content, region: "body" };
					endHead("invalid-element", startLine);
				} else endHead("body", startLine);
			}
		}
		tags.push({ name, attrs, attrOrder, line: startLine, offset, text: content, region: state === "body" ? "body" : "head" });
	}
	const invalidTag = invalid;
	// Metadata the author placed in <head> after the invalid element: Google ignores it.
	const ignoredAfterInvalid = invalidTag
		? tags.filter(
				(t) =>
					t.offset > invalidTag.offset &&
					t.offset < authorHeadClose &&
					VALID_HEAD[t.name] &&
					t.name !== "script" &&
					t.name !== "noscript" &&
					t.name !== "template",
			)
		: [];
	return { tags, invalid: invalidTag, ignoredAfterInvalid, headEnd };
}

export interface CanonicalLink {
	href: string;
	attrs: Record<string, string>;
	region: "head" | "body";
	line: number;
}

export interface MetaTag {
	name: string; // lowercased name, property or http-equiv key
	key: "name" | "property" | "http-equiv" | "charset" | "itemprop";
	content: string;
	region: "head" | "body";
	line: number;
}

export interface Anchor {
	href: string | null;
	text: string;
	attrs: Record<string, string>;
}

export interface NosnippetNode {
	tag: string;
	key: string; // stable identity across layers: `tag#id`, or `tag:nth(n)` among same-tag elements in document order
	value: string;
}

export interface HtmlSignals {
	lang: string | null;
	titles: { text: string; region: "head" | "body"; line: number }[];
	metas: MetaTag[];
	links: { rel: string; href: string; attrs: Record<string, string>; region: "head" | "body"; line: number }[];
	canonicals: CanonicalLink[];
	scripts: { src: string | null; type: string; attrs: Record<string, string>; region: "head" | "body"; line: number; text: string }[];
	base: string | null;
	headScan: { invalid: { tag: string; line: number } | null; ignoredAfterInvalid: { tag: string; line: number; attrs: Record<string, string> }[]; headEnd: HeadScan["headEnd"] };
	anchors: Anchor[];
	images: { src: string | null; alt: string | null; attrs: Record<string, string> }[];
	videos: { attrs: Record<string, string> }[];
	headings: { level: number; text: string }[];
	nosnippet: NosnippetNode[];
	hrefOnNonLink: { tag: string; href: string }[];
	mainText: string;
	microdata: boolean;
	rdfa: boolean;
}

function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export async function extractSignals(html: string): Promise<HtmlSignals> {
	const scan = scanHead(html);
	const sig: HtmlSignals = {
		lang: null,
		titles: [],
		metas: [],
		links: [],
		canonicals: [],
		scripts: [],
		base: null,
		headScan: {
			invalid: scan.invalid ? { tag: scan.invalid.name, line: scan.invalid.line } : null,
			ignoredAfterInvalid: scan.ignoredAfterInvalid.map((t) => ({ tag: t.name, line: t.line, attrs: t.attrs })),
			headEnd: scan.headEnd,
		},
		anchors: [],
		images: [],
		videos: [],
		headings: [],
		nosnippet: [],
		hrefOnNonLink: [],
		mainText: "",
		microdata: false,
		rdfa: false,
	};
	for (const t of scan.tags) {
		const a = t.attrs;
		if (t.name === "html") sig.lang = a.lang ?? null;
		else if (t.name === "title") sig.titles.push({ text: collapse(t.text), region: t.region, line: t.line });
		else if (t.name === "base" && sig.base === null && a.href !== undefined) sig.base = a.href;
		else if (t.name === "meta") {
			const keyed = (["name", "property", "http-equiv", "itemprop"] as const).find((k) => a[k] !== undefined);
			if (keyed) sig.metas.push({ name: (a[keyed] ?? "").toLowerCase().trim(), key: keyed, content: a.content ?? "", region: t.region, line: t.line });
			else if (a.charset !== undefined) sig.metas.push({ name: "charset", key: "charset", content: a.charset, region: t.region, line: t.line });
		} else if (t.name === "link") {
			const rel = (a.rel ?? "").toLowerCase().trim();
			sig.links.push({ rel, href: a.href ?? "", attrs: a, region: t.region, line: t.line });
			if (rel.split(/\s+/).includes("canonical")) sig.canonicals.push({ href: (a.href ?? "").trim(), attrs: a, region: t.region, line: t.line });
		} else if (t.name === "script")
			sig.scripts.push({ src: a.src ?? null, type: (a.type ?? "").toLowerCase().trim(), attrs: a, region: t.region, line: t.line, text: t.text });
		if (a.itemscope !== undefined) sig.microdata = true;
		if (a.typeof !== undefined || a.vocab !== undefined || (a.property !== undefined && t.name !== "meta")) sig.rdfa = true;
	}
	let anchor: Anchor | null = null;
	let heading: { level: number; text: string } | null = null;
	let hidden = 0;
	const text: string[] = [];
	const ordinals: Record<string, number> = {};
	await new HTMLRewriter()
		.on("*", {
			element(el) {
				const tag = el.tagName.toLowerCase();
				ordinals[tag] = (ordinals[tag] ?? 0) + 1;
				const n = ordinals[tag];
				// Bun's HTMLRewriter returns null from getAttribute for an empty or valueless attribute, so attributes are
				// read from the `attributes` iterator, which yields "" for them.
				const attrs: Record<string, string> = Object.fromEntries(el.attributes);
				const ns = attrs["data-nosnippet"];
				if (ns !== undefined) {
					const id = attrs.id;
					sig.nosnippet.push({ tag, key: id ? `${tag}#${id}` : `${tag}:nth(${n})`, value: ns });
				}
				const href = attrs.href;
				if (href !== undefined && tag !== "a" && tag !== "link" && tag !== "area" && tag !== "base")
					sig.hrefOnNonLink.push({ tag, href });
			},
		})
		.on("a", {
			element(el) {
				const attrs: Record<string, string> = Object.fromEntries(el.attributes);
				const current: Anchor = { href: attrs.href ?? null, text: "", attrs };
				anchor = current;
				sig.anchors.push(current);
				el.onEndTag(() => {
					current.text = collapse(decodeHtml(current.text));
					anchor = null;
				});
			},
			text(t) {
				if (anchor) anchor.text += t.text;
			},
		})
		.on("h1, h2, h3, h4, h5, h6", {
			element(el) {
				const current = { level: Number(el.tagName.slice(1)), text: "" };
				heading = current;
				el.onEndTag(() => {
					sig.headings.push({ level: current.level, text: collapse(decodeHtml(current.text)) });
					heading = null;
				});
			},
			text(t) {
				if (heading) heading.text += t.text;
			},
		})
		.on("img", {
			element(el) {
				const attrs: Record<string, string> = Object.fromEntries(el.attributes);
				sig.images.push({ src: attrs.src ?? null, alt: attrs.alt ?? null, attrs });
			},
		})
		.on("video", {
			element(el) {
				sig.videos.push({ attrs: Object.fromEntries(el.attributes) });
			},
		})
		// Text is collected for the whole document: HTMLRewriter sees only literal tags, so an implied <body> has no
		// handler. `head` is not counted as hidden because an implied </head> never fires an end-tag handler.
		.on("script, style, noscript, template, title", {
			element(el) {
				hidden++;
				el.onEndTag(() => {
					hidden--;
				});
			},
		})
		.onDocument({
			text(t) {
				if (!hidden) text.push(t.lastInTextNode ? `${t.text} ` : t.text);
			},
		})
		.transform(new Response(html))
		.arrayBuffer();
	sig.mainText = collapse(decodeHtml(text.join("")));
	return sig;
}
