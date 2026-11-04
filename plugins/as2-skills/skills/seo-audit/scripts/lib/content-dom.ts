// Element-level view of one HTML layer for the content family (scripts/rules/content.ts): anchors with their text and
// descendant images, images with their `<picture>` ancestry, headings, the `<title>` elements outside SVG, and every
// start tag numbered among its same-name siblings in document order, so locators read `html:<tag>:nth(N)` the same way
// in both layers. It is built synchronously on the head-order scanner (html.ts `scanHead`), because a Check is sync.
import { decodeHtml, scanHead, type Tag } from "./html.ts";

export interface DomTag extends Tag {
	nth: number; // 1-based position among elements with the same name, in document order
	end: number; // offset just past the start tag's closing `>`
}

export interface DomAnchor {
	tag: DomTag;
	text: string; // collapsed text content, tags removed
	imgAlts: (string | null)[]; // alt of each descendant <img>
}

export interface DomImage {
	tag: DomTag;
	inPicture: boolean;
}

export interface DomHeading {
	tag: DomTag;
	level: number;
	text: string;
}

export interface Dom {
	tags: DomTag[];
	anchors: DomAnchor[];
	images: DomImage[];
	headings: DomHeading[];
	titles: DomTag[]; // HTML <title> elements; an SVG <title> is not one
}

// The offset just past the `>` that closes the start tag at `offset`, quotes respected.
function startTagEnd(html: string, offset: number): number {
	let quote = "";
	for (let i = offset + 1; i < html.length; i++) {
		const c = html[i];
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") {
			// A quote only opens an attribute value right after `=` (whitespace allowed).
			if (/=\s*$/.test(html.slice(Math.max(offset, i - 8), i))) quote = c;
		} else if (c === ">") return i + 1;
	}
	return html.length;
}

// Text content between two offsets: comments, script, style and template bodies and tags removed, entities decoded.
export function textBetween(html: string, from: number, to: number): string {
	const slice = html
		.slice(from, to)
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ");
	return decodeHtml(slice).replace(/\s+/g, " ").trim();
}

// The offset of the end tag `</name>` that closes an element whose start tag ends at `from`, or the end of the document.
function closeOf(html: string, name: string, from: number): number {
	const re = new RegExp(`</${name}\\s*>`, "gi");
	re.lastIndex = from;
	const m = re.exec(html);
	return m ? m.index : html.length;
}

export function buildDom(html: string): Dom {
	const counts: Record<string, number> = {};
	const tags: DomTag[] = scanHead(html).tags.map((t) => {
		counts[t.name] = (counts[t.name] ?? 0) + 1;
		return { ...t, nth: counts[t.name] ?? 1, end: startTagEnd(html, t.offset) };
	});
	// Element extents of <svg> and <picture>, for "is this element inside one".
	const extent: Record<"svg" | "picture", [number, number][]> = { svg: [], picture: [] };
	for (const t of tags) if (t.name === "svg" || t.name === "picture") extent[t.name].push([t.offset, closeOf(html, t.name, t.end)]);
	const within = (offset: number, name: "svg" | "picture") => extent[name].some(([a, b]) => offset > a && offset < b);
	const anchors: DomAnchor[] = tags
		.filter((t) => t.name === "a")
		.map((t) => {
			const close = closeOf(html, "a", t.end);
			const imgAlts = tags.filter((i) => i.name === "img" && i.offset > t.offset && i.offset < close).map((i) => i.attrs.alt ?? null);
			return { tag: t, text: textBetween(html, t.end, close), imgAlts };
		});
	const images: DomImage[] = tags.filter((t) => t.name === "img").map((t) => ({ tag: t, inPicture: within(t.offset, "picture") }));
	const headings: DomHeading[] = tags
		.filter((t) => /^h[1-6]$/.test(t.name))
		.map((t) => ({ tag: t, level: Number(t.name.slice(1)), text: textBetween(html, t.end, closeOf(html, t.name, t.end)) }));
	const titles = tags.filter((t) => t.name === "title" && !within(t.offset, "svg"));
	return { tags, anchors, images, headings, titles };
}

// One Dom per HTML string: the content family reads each layer many times in one run.
const cache = new Map<string, Dom>();
export function domOf(html: string): Dom {
	let d = cache.get(html);
	if (!d) {
		d = buildDom(html);
		cache.set(html, d);
	}
	return d;
}
