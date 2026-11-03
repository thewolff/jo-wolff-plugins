// Text detectors for the framework rules (rules.md FW-NEXT-01/02/04/05/23, FW-VITE-07) over the source layer's files.
// The audited project's code is never run or imported: exports are found by line-anchored patterns, and object literals
// are read with a small scanner that skips strings, template literals and comments, so a brace or comma inside a string
// never ends a value. JSX text is never scanned: only the export statements and the objects they hold are.
import type { SourceEvidence, SourceFile } from "./source.ts";

export interface Entry {
	key: string;
	keyOffset: number; // offset of the key in the file text
	value: string; // the value's source text, trimmed; "" for a shorthand property
	valueOffset: number;
}

export interface MetadataObject {
	file: SourceFile;
	via: "metadata" | "generateMetadata";
	offset: number; // offset of the object's `{`
	entries: Entry[];
}

export interface MetadataExport {
	kind: "metadata" | "generateMetadata";
	offset: number; // offset of the `export` keyword
	body: string; // the object literal (metadata) or the function body (generateMetadata), "" when not found
	objects: MetadataObject[]; // the `metadata` object, or each `return { … }` object of generateMetadata
}

const METADATA_EXPORT = /^export\s+(?:const|let|var)\s+metadata\b/gm;
const GENERATE_EXPORT = /^export\s+(?:(?:async\s+)?function\s+generateMetadata\b|(?:const|let|var)\s+generateMetadata\b)/gm;
const ROUTE_FILE = /\.(js|jsx|ts|tsx)$/;
const LAYOUT_NAMES = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"];
const OPEN: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

export function lineAt(text: string, offset: number): number {
	let n = 1;
	for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

// The offset just past a string, template literal or comment starting at `i`, or `i` when none starts there.
function skipNonCode(text: string, i: number): number {
	const c = text[i];
	if (c === "/" && text[i + 1] === "/") {
		const end = text.indexOf("\n", i);
		return end < 0 ? text.length : end;
	}
	if (c === "/" && text[i + 1] === "*") {
		const end = text.indexOf("*/", i + 2);
		return end < 0 ? text.length : end + 2;
	}
	if (c === "'" || c === '"' || c === "`") {
		let j = i + 1;
		let depth = 0; // `${ … }` nesting inside a template literal
		while (j < text.length) {
			const d = text[j];
			if (d === "\\") j += 2;
			else if (c === "`" && d === "$" && text[j + 1] === "{") {
				depth++;
				j += 2;
			} else if (c === "`" && depth > 0 && d === "}") {
				depth--;
				j++;
			} else if (d === c && depth === 0) return j + 1;
			else if (d === "\n" && c !== "`") return j; // unterminated: stop at the line end
			else j++;
		}
		return text.length;
	}
	return i;
}

// The offset of the bracket that closes the one at `open`, or -1.
export function matchBracket(text: string, open: number): number {
	const stack: string[] = [];
	let i = open;
	while (i < text.length) {
		const skipped = skipNonCode(text, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const c = text[i] ?? "";
		const close = OPEN[c];
		if (close) stack.push(close);
		else if (c === "}" || c === "]" || c === ")") {
			if (stack.pop() !== c) return -1;
			if (stack.length === 0) return i;
		}
		i++;
	}
	return -1;
}

// The depth-1 entries of the object literal whose `{` is at `open`.
export function objectEntries(text: string, open: number): Entry[] {
	const close = matchBracket(text, open);
	if (close < 0) return [];
	const segments: { start: number; end: number }[] = [];
	let start = open + 1;
	let i = open + 1;
	while (i < close) {
		const skipped = skipNonCode(text, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const c = text[i] ?? "";
		if (OPEN[c]) {
			const end = matchBracket(text, i);
			if (end < 0) return [];
			i = end + 1;
			continue;
		}
		if (c === ",") {
			segments.push({ start, end: i });
			start = i + 1;
		}
		i++;
	}
	segments.push({ start, end: close });
	const out: Entry[] = [];
	for (const s of segments) {
		const raw = text.slice(s.start, s.end);
		const lead = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(raw)?.[0].length ?? 0;
		const m = /^(?:(['"])([^'"]*)\1|([A-Za-z_$][\w$]*))\s*(:)?/.exec(raw.slice(lead));
		if (!m) continue;
		const key = m[2] ?? m[3] ?? "";
		const keyOffset = s.start + lead;
		if (!m[4]) {
			if (m[3] && raw.slice(lead).trim() === m[3]) out.push({ key, keyOffset, value: "", valueOffset: keyOffset });
			continue;
		}
		const after = raw.slice(lead + m[0].length);
		const vlead = after.length - after.trimStart().length;
		out.push({ key, keyOffset, value: after.trim(), valueOffset: keyOffset + m[0].length + vlead });
	}
	return out;
}

// A plain string literal's content ('…', "…" or a template literal without `${`), or null.
export function stringValue(value: string): string | null {
	const m = /^(['"`])([\s\S]*)\1$/.exec(value.trim());
	if (!m || (m[1] === "`" && (m[2] ?? "").includes("${"))) return null;
	return m[2] ?? null;
}

// `new URL('…')` or a string literal: the URL text, or null.
export function urlValue(value: string): string | null {
	const m = /^new\s+URL\s*\(\s*(['"`][^'"`]*['"`])\s*\)$/.exec(value.trim());
	return stringValue(m?.[1] ?? value);
}

// Entries of an entry whose value is an object literal.
export function childEntries(text: string, e: Entry | undefined): Entry[] {
	return e && e.value.startsWith("{") ? objectEntries(text, e.valueOffset) : [];
}

// The elements of an array literal value: each element's trimmed text and offset.
export function arrayElements(text: string, e: Entry): { value: string; offset: number }[] {
	if (!e.value.startsWith("[")) return [];
	const open = e.valueOffset;
	const close = matchBracket(text, open);
	if (close < 0) return [];
	const out: { value: string; offset: number }[] = [];
	let start = open + 1;
	let i = open + 1;
	const push = (end: number) => {
		const raw = text.slice(start, end);
		if (raw.trim()) out.push({ value: raw.trim(), offset: start + raw.length - raw.trimStart().length });
	};
	while (i < close) {
		const skipped = skipNonCode(text, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const c = text[i] ?? "";
		if (OPEN[c]) {
			const end = matchBracket(text, i);
			if (end < 0) return out;
			i = end + 1;
			continue;
		}
		if (c === ",") {
			push(i);
			start = i + 1;
		}
		i++;
	}
	push(close);
	return out;
}

// The first `{` at or after `from` that is not inside a string or comment, before `limit`.
function nextBrace(text: string, from: number, limit = text.length): number {
	let i = from;
	while (i < limit) {
		const skipped = skipNonCode(text, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		if (text[i] === "{") return i;
		i++;
	}
	return -1;
}

export function metadataExports(file: SourceFile): MetadataExport[] {
	const text = file.text ?? "";
	const out: MetadataExport[] = [];
	for (const m of text.matchAll(METADATA_EXPORT)) {
		// `export const metadata: Metadata = { … }`: the object starts after the `=`.
		const eq = text.indexOf("=", m.index + m[0].length);
		const open = eq < 0 ? -1 : nextBrace(text, eq);
		const ok = open >= 0 && text.slice(eq + 1, open).trim() === "";
		const close = ok ? matchBracket(text, open) : -1;
		out.push({
			kind: "metadata",
			offset: m.index,
			body: close > 0 ? text.slice(open, close + 1) : "",
			objects: close > 0 ? [{ file, via: "metadata", offset: open, entries: objectEntries(text, open) }] : [],
		});
	}
	for (const m of text.matchAll(GENERATE_EXPORT)) {
		// The function body: the first `{` after the parameter list's `)` (or after `=>`).
		const params = text.indexOf("(", m.index + m[0].length);
		const paramsEnd = params < 0 ? -1 : matchBracket(text, params);
		const open = paramsEnd < 0 ? -1 : nextBrace(text, paramsEnd + 1);
		const close = open < 0 ? -1 : matchBracket(text, open);
		const objects: MetadataObject[] = [];
		if (close > 0)
			for (const r of text.slice(open, close).matchAll(/\breturn\s*\{/g)) {
				const at = open + r.index + r[0].length - 1;
				objects.push({ file, via: "generateMetadata", offset: at, entries: objectEntries(text, at) });
			}
		out.push({ kind: "generateMetadata", offset: m.index, body: close > 0 ? text.slice(open, close + 1) : "", objects });
	}
	return out.sort((a, b) => a.offset - b.offset);
}

// True when the file's first statement is the 'use client' directive (comments and blank lines before it allowed).
export function isClientFile(file: SourceFile): boolean {
	const text = file.text ?? "";
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i] ?? "")) {
			i++;
			continue;
		}
		const skipped = text[i] === "/" ? skipNonCode(text, i) : i;
		if (skipped === i) break;
		i = skipped;
	}
	return /^(['"])use client\1\s*(;|\n|$)/.test(text.slice(i));
}

// Next.js App Router project (frameworks.md FW-NEXT-00, FW-NEXT-00b): `next` declared or a supported next.config, and
// an app/ (or src/app/) directory.
export function nextAppDir(source: SourceEvidence | null): string | null {
	if (!source?.router.app) return null;
	const config = source.files.some((f) => /^next\.config\.(js|mjs|ts)$/.test(f.path));
	return source.framework.next !== null || config ? source.router.app : null;
}

// Route files under the app directory, outside private folders (`_name`), which are not routable.
export function appFiles(source: SourceEvidence, app: string): SourceFile[] {
	return source.files.filter((f) => f.path.startsWith(`${app}/`) && ROUTE_FILE.test(f.path) && !f.path.slice(app.length + 1).split("/").some((s) => s.startsWith("_")));
}

export function isPage(path: string): boolean {
	return /(^|\/)page\.(js|jsx|ts|tsx)$/.test(path);
}

export function isLayout(path: string): boolean {
	return /(^|\/)layout\.(js|jsx|ts|tsx)$/.test(path);
}

// The layout files from the app root down to the file's own directory, outermost first.
export function ancestorLayouts(source: SourceEvidence, app: string, path: string): SourceFile[] {
	const dirs = path.split("/").slice(0, -1);
	const out: SourceFile[] = [];
	for (let n = app.split("/").length; n <= dirs.length; n++) {
		const dir = dirs.slice(0, n).join("/");
		for (const name of LAYOUT_NAMES) {
			const f = source.files.find((x) => x.path === `${dir}/${name}`);
			if (f) {
				out.push(f);
				break;
			}
		}
	}
	return out;
}

// A Vite single-page app (FW-VITE-00, -00c, -03): vite declared or a vite.config at the root, a root index.html, appType
// left at its 'spa' default, and no SSR or prerender build in package.json scripts or an entry-server file. The source
// layer collects package.json, vite.config.* and index.html only, so a server.js that calls createViteServer is not seen.
export function viteSpaIndex(source: SourceEvidence | null): SourceFile | null {
	if (!source) return null;
	const config = source.files.find((f) => /^vite\.config\.[cm]?[jt]s$/.test(f.path));
	if (source.framework.vite === null && !config) return null;
	const index = source.files.find((f) => f.path === "index.html");
	if (!index?.text) return null;
	if (config?.text && /\bappType\s*:\s*['"`](custom|mpa)['"`]/.test(config.text)) return null;
	if (source.files.some((f) => /(^|\/)entry-server\.[cm]?[jt]sx?$/.test(f.path))) return null;
	const pkg = source.files.find((f) => f.path === "package.json");
	let scripts: Record<string, string> = {};
	try {
		const parsed = JSON.parse(pkg?.text ?? "{}") as { scripts?: Record<string, string> };
		scripts = parsed.scripts ?? {};
	} catch {
		scripts = {};
	}
	if (Object.values(scripts).some((s) => /--ssr\b|\bprerender\b/.test(s))) return null;
	return index;
}
