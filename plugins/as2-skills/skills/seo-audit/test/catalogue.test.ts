// Catalogue sourcing invariants for skills/seo-audit (plan section 4, owned by sl-seo-rules). Every rules.md,
// do-not-flag.md and frameworks.md row cites a URL listed in sources.md, and its quote appears verbatim in a shipped
// references/research/ file. Every row id in the six research files has exactly one disposition in sources.md
// (admitted, dropped or do-not-flag), and an admitted or do-not-flag disposition names a row that exists.
// Reads files only; needs no network, engine or fixture.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..");
const REF = join(SKILL, "references");
const RESEARCH = join(REF, "research");
const RESEARCH_FILES = [
	"google-core",
	"structured-data",
	"performance-lighthouse",
	"ai-crawlers-bing",
	"frameworks",
	"survey",
];
const ID = /^(?:[A-Z]+-)+[A-Z]*\d+[a-z]?$/;
const SEP = /^\|\s*:?-{2,}/;
const LAYERS: Record<string, true> = {
	"raw-html": true,
	rendered: true,
	headers: true,
	robots: true,
	sitemap: true,
	"structured-data": true,
	lab: true,
	field: true,
	"ua-probe": true,
	source: true,
	site: true,
};
const RULE_COLS = [
	"id",
	"category",
	"requirement",
	"check",
	"layer",
	"mode",
	"applies-when",
	"intent-effect",
	"kind",
	"severity",
	"fix",
	"source URL",
	"quote",
	"detection-basis",
];
const DNF_COLS = ["id", "do not flag", "instead", "source URL", "quote", "planted-in"];
const FW_COLS = ["id", "framework", "kind", "what to look for", "locates", "source URL", "quote"];
const DISP_COLS = ["file", "research id", "disposition", "catalogue id", "reason"];

const read = (p: string) => readFileSync(p, "utf8");

// One markdown table row into cells; `\|` inside a cell is an escaped pipe, not a separator.
function cells(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

// The rows of the table whose header is exactly `cols`, as column-name -> cell maps.
function table(text: string, cols: string[]): Record<string, string>[] {
	const lines = text.split("\n");
	const at = lines.findIndex(
		(l, n) => l.startsWith("|") && SEP.test(lines[n + 1] ?? "") && cells(l).join("\u0000") === cols.join("\u0000"),
	);
	if (at < 0) throw new Error(`no table with columns: ${cols.join(" | ")}`);
	const out: Record<string, string>[] = [];
	for (const l of lines.slice(at + 2)) {
		if (!l.startsWith("|")) break;
		const c = cells(l);
		if (c.length !== cols.length) throw new Error(`row has ${c.length} cells, expected ${cols.length}: ${l.slice(0, 120)}`);
		out.push(Object.fromEntries(cols.map((k, i) => [k, c[i]])));
	}
	return out;
}

// Every row id in a research file: rows of any table (header followed by a separator) whose first cell is an id.
function researchIds(file: string): string[] {
	const lines = read(join(RESEARCH, `${file}.md`)).split("\n");
	const ids: string[] = [];
	let inTable = false;
	for (let n = 0; n < lines.length; n++) {
		const l = lines[n];
		if (l.startsWith("|") && SEP.test(lines[n + 1] ?? "")) {
			inTable = true;
			continue;
		}
		if (!l.startsWith("|")) continue;
		if (!inTable || SEP.test(l)) continue;
		const id = cells(l)[0].replace(/[`*\s]/g, "");
		if (ID.test(id)) ids.push(id);
	}
	return ids;
}

const corpus = readdirSync(RESEARCH)
	.filter((f) => f.endsWith(".md"))
	.map((f) => read(join(RESEARCH, f)))
	.join("\n");
const sources = read(join(REF, "sources.md"));
const rules = table(read(join(REF, "rules.md")), RULE_COLS);
const dnf = table(read(join(REF, "do-not-flag.md")), DNF_COLS);
const fw = table(read(join(REF, "frameworks.md")), FW_COLS);
const disp = table(sources, DISP_COLS);

// Source URL listed in sources.md, quote verbatim in research/: the gate every catalogue row passes.
function sourcingFailures(rows: Record<string, string>[]): string[] {
	const bad: string[] = [];
	for (const r of rows) {
		const url = r["source URL"];
		const quote = r.quote;
		if (!/^https?:\/\//.test(url)) bad.push(`${r.id}: source URL is not a URL: ${url}`);
		else if (!sources.includes(url)) bad.push(`${r.id}: source URL not listed in sources.md: ${url}`);
		if (!quote) bad.push(`${r.id}: empty quote`);
		else if (!corpus.includes(quote) && !corpus.includes(quote.replaceAll("\\|", "|")))
			bad.push(`${r.id}: quote not found verbatim in references/research/: ${quote.slice(0, 100)}`);
	}
	return bad;
}

test("catalogue tables have their exact columns and unique ids", () => {
	expect(rules.length).toBeGreaterThan(0);
	expect(dnf.length).toBeGreaterThan(0);
	expect(fw.length).toBeGreaterThan(0);
	const ids = [...rules, ...dnf, ...fw].map((r) => r.id);
	expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
});

test("every rules.md row cites a listed URL and quotes research/ verbatim", () => {
	expect(sourcingFailures(rules)).toEqual([]);
});

test("every do-not-flag row cites a listed URL and quotes research/ verbatim", () => {
	expect(sourcingFailures(dnf)).toEqual([]);
});

test("every frameworks.md row cites a listed URL and quotes research/ verbatim", () => {
	expect(sourcingFailures(fw)).toEqual([]);
});

test("rules.md enums, severity model and judgment evidence", () => {
	const bad: string[] = [];
	for (const r of rules) {
		for (const l of r.layer.split(",").map((s) => s.trim())) if (!LAYERS[l]) bad.push(`${r.id}: layer ${l}`);
		if (!["mechanical", "judgment"].includes(r.mode)) bad.push(`${r.id}: mode ${r.mode}`);
		if (r.mode === "judgment" && !r.check.includes("Evidence:")) bad.push(`${r.id}: judgment check names no Evidence:`);
		if (!["observe", "keep"].includes(r["intent-effect"])) bad.push(`${r.id}: intent-effect ${r["intent-effect"]}`);
		if (r.kind === "finding") {
			if (!["critical", "high", "medium", "low"].includes(r.severity)) bad.push(`${r.id}: finding severity ${r.severity}`);
		} else if (r.kind === "observation") {
			if (r.severity !== "") bad.push(`${r.id}: observation has severity ${r.severity}`);
		} else bad.push(`${r.id}: kind ${r.kind}`);
		for (const k of ["category", "requirement", "check", "applies-when", "fix", "detection-basis"])
			if (!r[k]) bad.push(`${r.id}: empty ${k}`);
	}
	expect(bad).toEqual([]);
	const keep = rules.filter((r) => r["intent-effect"] === "keep").map((r) => r.id);
	expect(keep.sort()).toEqual(["IDX-002", "IDX-003"]);
});

test("frameworks.md rows are detection or locator notes", () => {
	expect(fw.filter((r) => !["detection", "locator"].includes(r.kind)).map((r) => r.id)).toEqual([]);
});

test("every research row id has one disposition, and it names an existing row", () => {
	const expected = new Map<string, string>();
	for (const f of RESEARCH_FILES) {
		const ids = researchIds(f);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
		for (const id of ids) expected.set(`${f} ${id}`, f);
	}
	expect(expected.size).toBe(710);
	const ruleIds = new Set([...rules, ...fw].map((r) => r.id));
	const dnfIds = new Set(dnf.map((r) => r.id));
	const seen = new Set<string>();
	const bad: string[] = [];
	for (const d of disp) {
		const key = `${d.file} ${d["research id"]}`;
		if (!expected.has(key)) bad.push(`${key}: not a research row`);
		if (seen.has(key)) bad.push(`${key}: more than one disposition`);
		seen.add(key);
		const cid = d["catalogue id"];
		if (d.disposition === "admitted") {
			if (!ruleIds.has(cid)) bad.push(`${key}: admitted as ${cid}, which is not a rules.md or frameworks.md row`);
		} else if (d.disposition === "do-not-flag") {
			if (!dnfIds.has(cid)) bad.push(`${key}: do-not-flag as ${cid}, which is not a do-not-flag.md row`);
		} else if (d.disposition === "dropped") {
			if (!d.reason) bad.push(`${key}: dropped without a reason`);
		} else bad.push(`${key}: disposition ${d.disposition}`);
	}
	for (const key of expected.keys()) if (!seen.has(key)) bad.push(`${key}: no disposition`);
	expect(bad).toEqual([]);
});

test("every catalogue row is the target of some disposition", () => {
	const targets = new Set(disp.map((d) => d["catalogue id"]));
	// suffixed second rules (HEU-02b, CWV-001b, …) cite the same research row as their unsuffixed sibling
	const orphan = [...rules, ...dnf, ...fw]
		.map((r) => r.id)
		.filter((id) => !targets.has(id) && !targets.has(id.replace(/[a-z]$/, "")));
	expect(orphan).toEqual([]);
});
