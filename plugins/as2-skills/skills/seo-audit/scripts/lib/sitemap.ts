// Sitemap reader: a small hand-written XML tokenizer (well-formedness, entities, CDATA, comments, namespaces) and the
// sitemaps.org urlset / sitemapindex model with the image, xhtml and news extensions, plus text sitemaps.

export const NS = {
	sitemap: "http://www.sitemaps.org/schemas/sitemap/0.9",
	image: "http://www.google.com/schemas/sitemap-image/1.1",
	xhtml: "http://www.w3.org/1999/xhtml",
	news: "http://www.google.com/schemas/sitemap-news/0.9",
	video: "http://www.google.com/schemas/sitemap-video/1.1",
};

export interface XmlElement {
	ns: string; // namespace URI, "" when none
	local: string;
	attrs: Record<string, string>;
	line: number;
	children: XmlElement[];
	text: string;
}

export class XmlError extends Error {
	constructor(
		message: string,
		readonly line: number,
	) {
		super(`line ${line}: ${message}`);
	}
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string, line: number): string {
	return s.replace(/&([^;\s&<]*);?/g, (m, name: string) => {
		if (!m.endsWith(";")) throw new XmlError(`bare '&' (unterminated entity reference)`, line);
		if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
		if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
		const v = PREDEFINED[name];
		if (v === undefined) throw new XmlError(`undefined entity &${name};`, line);
		return v;
	});
}

interface Open {
	el: XmlElement;
	qname: string;
	scope: Record<string, string>;
}

// Parses a whole XML document into an element tree; throws XmlError at the first well-formedness error.
export function parseXml(text: string): XmlElement {
	let i = 0;
	let line = 1;
	const advance = (to: number) => {
		for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++;
		i = to;
	};
	const stack: Open[] = [];
	let root: XmlElement | null = null;
	if (text.charCodeAt(0) === 0xfeff) i = 1;
	while (i < text.length) {
		const lt = text.indexOf("<", i);
		const chunk = text.slice(i, lt < 0 ? text.length : lt);
		if (chunk) {
			const top = stack[stack.length - 1];
			if (top) top.el.text += decodeEntities(chunk, line);
			else if (chunk.trim()) throw new XmlError("text outside the root element", line);
			advance(i + chunk.length);
		}
		if (lt < 0) break;
		const at = line;
		if (text.startsWith("<?", i)) {
			const end = text.indexOf("?>", i);
			if (end < 0) throw new XmlError("unterminated processing instruction", at);
			if (text.slice(i + 2, i + 5).toLowerCase() === "xml" && (i > 1 || stack.length || root))
				throw new XmlError("XML declaration not at the start", at);
			advance(end + 2);
			continue;
		}
		if (text.startsWith("<!--", i)) {
			const end = text.indexOf("-->", i + 4);
			if (end < 0) throw new XmlError("unterminated comment", at);
			advance(end + 3);
			continue;
		}
		if (text.startsWith("<![CDATA[", i)) {
			const end = text.indexOf("]]>", i);
			if (end < 0) throw new XmlError("unterminated CDATA section", at);
			const top = stack[stack.length - 1];
			if (!top) throw new XmlError("CDATA outside the root element", at);
			top.el.text += text.slice(i + 9, end);
			advance(end + 3);
			continue;
		}
		if (text.startsWith("<!DOCTYPE", i)) {
			if (root || stack.length) throw new XmlError("DOCTYPE after the root element", at);
			const end = text.indexOf(">", i);
			if (end < 0 || text.slice(i, end).includes("[")) throw new XmlError("DOCTYPE internal subsets are not accepted", at);
			advance(end + 1);
			continue;
		}
		const close = text.startsWith("</", i);
		let j = i + (close ? 2 : 1);
		let quote = "";
		for (; j < text.length; j++) {
			const c = text[j];
			if (quote) {
				if (c === quote) quote = "";
			} else if (c === '"' || c === "'") quote = c;
			else if (c === ">") break;
			else if (c === "<") throw new XmlError("'<' inside a tag", line);
		}
		if (j >= text.length) throw new XmlError("unterminated tag", at);
		let inner = text.slice(i + (close ? 2 : 1), j);
		advance(j + 1);
		if (close) {
			const qname = inner.trim();
			const top = stack.pop();
			if (!top) throw new XmlError(`end tag </${qname}> without a start tag`, at);
			if (top.qname !== qname) throw new XmlError(`end tag </${qname}> does not match <${top.qname}>`, at);
			continue;
		}
		const selfClosing = inner.endsWith("/");
		if (selfClosing) inner = inner.slice(0, -1);
		const nameMatch = inner.match(/^\s*([^\s/>]+)/);
		const qname = nameMatch?.[1] ?? "";
		if (!NAME.test(qname)) throw new XmlError(`bad element name '${qname}'`, at);
		const attrs: Record<string, string> = {};
		const attrText = inner.slice((nameMatch?.[0] ?? "").length);
		const attrRe = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
		let consumed = 0;
		for (const m of attrText.matchAll(attrRe)) {
			if (m.index !== consumed) throw new XmlError(`malformed attributes on <${qname}>`, at);
			const name = m[1] ?? "";
			if (name in attrs) throw new XmlError(`duplicate attribute ${name} on <${qname}>`, at);
			attrs[name] = decodeEntities(m[3] ?? m[4] ?? "", at);
			consumed = m.index + m[0].length;
		}
		if (attrText.slice(consumed).trim()) throw new XmlError(`malformed attributes on <${qname}>`, at);
		const parentScope = stack[stack.length - 1]?.scope ?? { xml: "http://www.w3.org/XML/1998/namespace" };
		const scope = { ...parentScope };
		for (const [k, v] of Object.entries(attrs)) {
			if (k === "xmlns") scope[""] = v;
			else if (k.startsWith("xmlns:")) scope[k.slice(6)] = v;
		}
		const colon = qname.indexOf(":");
		const prefix = colon >= 0 ? qname.slice(0, colon) : "";
		const ns = scope[prefix];
		if (prefix && ns === undefined) throw new XmlError(`undeclared namespace prefix '${prefix}'`, at);
		const el: XmlElement = { ns: ns ?? "", local: colon >= 0 ? qname.slice(colon + 1) : qname, attrs, line: at, children: [], text: "" };
		const parent = stack[stack.length - 1];
		if (parent) parent.el.children.push(el);
		else if (root) throw new XmlError("more than one root element", at);
		else root = el;
		if (!selfClosing) stack.push({ el, qname, scope });
	}
	const open = stack[stack.length - 1];
	if (open) throw new XmlError(`<${open.qname}> is never closed`, line);
	if (!root) throw new XmlError("no root element", line);
	return root;
}

export interface SitemapUrl {
	line: number;
	loc: string | null;
	locLine: number;
	lastmod: string | null;
	lastmodLine: number;
	priority: string | null;
	changefreq: string | null;
	images: { loc: string | null; line: number }[];
	alternates: { rel: string; hreflang: string; href: string; line: number }[];
	news: boolean;
}

export interface SitemapRef {
	line: number;
	loc: string | null;
	lastmod: string | null;
	lastmodLine: number;
}

export interface ParsedSitemap {
	type: "urlset" | "sitemapindex" | "text" | "unknown";
	urls: SitemapUrl[];
	sitemaps: SitemapRef[];
	error: { message: string; line: number } | null;
	textLines: { line: number; value: string }[]; // text sitemaps only: every non-empty line
}

// A sitemaps.org element: in the sitemap namespace, or unqualified (lenient for files missing the xmlns).
function isSm(el: XmlElement, local: string): boolean {
	return el.local === local && (el.ns === NS.sitemap || el.ns === "");
}

function child(el: XmlElement, local: string): XmlElement | undefined {
	return el.children.find((c) => isSm(c, local));
}

export function parseSitemap(body: string, url: string): ParsedSitemap {
	const out: ParsedSitemap = { type: "unknown", urls: [], sitemaps: [], error: null, textLines: [] };
	const trimmed = body.replace(/^\uFEFF/, "").trimStart();
	if (!trimmed.startsWith("<")) {
		if (/\.txt(\?|$)/i.test(new URL(url).pathname) || /^https?:\/\//i.test(trimmed)) {
			out.type = "text";
			body.split(/\r\n|\r|\n/).forEach((l, n) => {
				if (l.trim()) out.textLines.push({ line: n + 1, value: l.trim() });
			});
			return out;
		}
	}
	let root: XmlElement;
	try {
		root = parseXml(body);
	} catch (e) {
		out.error = e instanceof XmlError ? { message: e.message, line: e.line } : { message: String(e), line: 0 };
		return out;
	}
	if (isSm(root, "urlset")) {
		out.type = "urlset";
		for (const u of root.children.filter((c) => isSm(c, "url"))) {
			const loc = child(u, "loc");
			const lastmod = child(u, "lastmod");
			out.urls.push({
				line: u.line,
				loc: loc ? loc.text.trim() : null,
				locLine: loc?.line ?? u.line,
				lastmod: lastmod ? lastmod.text.trim() : null,
				lastmodLine: lastmod?.line ?? u.line,
				priority: child(u, "priority")?.text.trim() ?? null,
				changefreq: child(u, "changefreq")?.text.trim() ?? null,
				images: u.children
					.filter((c) => c.ns === NS.image && c.local === "image")
					.map((img) => {
						const l = img.children.find((c) => c.ns === NS.image && c.local === "loc");
						return { loc: l ? l.text.trim() : null, line: img.line };
					}),
				alternates: u.children
					.filter((c) => c.ns === NS.xhtml && c.local === "link")
					.map((l) => ({ rel: l.attrs.rel ?? "", hreflang: l.attrs.hreflang ?? "", href: l.attrs.href ?? "", line: l.line })),
				news: u.children.some((c) => c.ns === NS.news),
			});
		}
	} else if (isSm(root, "sitemapindex")) {
		out.type = "sitemapindex";
		for (const s of root.children.filter((c) => isSm(c, "sitemap"))) {
			const loc = child(s, "loc");
			const lastmod = child(s, "lastmod");
			out.sitemaps.push({
				line: s.line,
				loc: loc ? loc.text.trim() : null,
				lastmod: lastmod ? lastmod.text.trim() : null,
				lastmodLine: lastmod?.line ?? s.line,
			});
		}
	} else out.error = { message: `root element <${root.local}> is neither urlset nor sitemapindex`, line: root.line };
	return out;
}

// W3C Datetime (https://www.w3.org/TR/NOTE-datetime), the format sitemaps require for <lastmod>.
export const W3C_DATETIME =
	/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?)?)?$/;
