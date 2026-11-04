// Fixture tests for the performance and framework family (scripts/rules/perf-framework.ts): rules.md categories
// core-web-vitals, lab, performance and framework, plus the do-not-flag notes DNF-18, FW-DNF-11 and FW-DNF-12. Every
// fixture under test/fixtures/ is served on its loopback port and audited offline: rendered pages, lhr.json (a real
// Lighthouse 13 recording, with the numeric values lhr-edits.json lists written over it) and crux.json (CrUX API
// bodies) are replayed, and `audit.repo` source trees are read as text. The family's emissions must equal each
// fixture's expect/perf-framework.json as a multiset. Re-record perf-lab's lhr.json with audit.ts --record-lhr.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalogue } from "../scripts/lib/catalogue.ts";
import type { Json } from "../scripts/lib/jsonld.ts";
import { arrayElements, isClientFile, metadataExports, objectEntries, stringValue } from "../scripts/lib/perf-framework-source.ts";
import { type AuditRun, FIXTURES_DIR, auditFixture, compareOccurrences, familyEmissions, fixtureNames, loadExpect } from "./harness.ts";

const FAMILY_NAME = "perf-framework";
const FAMILY: Record<string, true> = { "core-web-vitals": true, lab: true, performance: true, framework: true };
const catalogue = loadCatalogue();
// The family's notes: three named ones, plus every PERF-DNF row whose planted-in names a fixture (none today).
const PLANTED_PERF_DNF = [...catalogue.dnf.values()].filter((n) => n.id.startsWith("PERF-DNF-") && /^test\/fixtures\//.test(n.plantedIn)).map((n) => n.id);
const NOTES = ["DNF-18", "FW-DNF-11", "FW-DNF-12", ...PLANTED_PERF_DNF];
// Field values and planted lab values cannot be reproduced live (PLAN section 4): their occurrences are [recorded].
const FIELD_VALUE_RULES: Record<string, true> = { "CWV-001": true, "CWV-001b": true, "CWV-002": true, "CWV-002b": true, "CWV-003": true, "CWV-003b": true };
const LAB_METRIC_AUDIT: Record<string, string> = { "LH-P01": "largest-contentful-paint", "LH-P02": "cumulative-layout-shift" };

const familyRows = [...catalogue.rules.values()].filter((r) => FAMILY[r.category]);
const familyIds = familyRows.filter((r) => r.mode === "mechanical").map((r) => r.id);
const judgmentIds = familyRows.filter((r) => r.mode === "judgment").map((r) => r.id);
const owned: Record<string, true> = Object.fromEntries([...familyIds, ...NOTES].map((id) => [id, true] as const));
const names = fixtureNames();
const controls = names.filter((n) => n.startsWith("control-"));
const runs = new Map<string, AuditRun>();

beforeAll(async () => {
	const done = await Promise.all(names.map(async (n) => [n, await auditFixture(n)] as const));
	for (const [n, r] of done) runs.set(n, r);
}, 60_000);

describe("fixtures match expect/perf-framework.json", () => {
	for (const name of names) {
		test(name, () => {
			const run = runs.get(name);
			expect(run?.stderr ?? "").not.toContain("seo-audit failed");
			expect(run?.code).toBe(0);
			expect(compareOccurrences(loadExpect(name, FAMILY_NAME), familyEmissions(run, owned), "recorded")).toEqual({ missing: [], unexpected: [] });
		});
	}
});

test("CWV-040 credits a stylesheet aspect-ratio from the rendered computed style, and still flags unsized images", () => {
	const hits = (runs.get("perf-markup")?.emissions ?? []).filter((e) => e.rule === "CWV-040" && e.path === "/").map((e) => e.locator);
	// img:nth(5) is sized only by `.booth { aspect-ratio: 2 / 1 }` in a <style> element; rendered computed style "2 / 1".
	expect(hits).not.toContain("html:img:nth(5)");
	expect(hits).toContain("html:img:nth(2)");
	expect(hits).toContain("html:img:nth(3)");
});

test("every mechanical perf-framework rule is planted in some expect/perf-framework.json", () => {
	expect(familyIds.length).toBe(20);
	const planted: Record<string, true> = {};
	for (const name of names) for (const o of loadExpect(name, FAMILY_NAME)) if (o.kind !== "dnf-note") planted[o.rule] = true;
	expect(familyIds.filter((id) => !planted[id])).toEqual([]);
});

test("the engine implements every mechanical perf-framework rule", () => {
	const run = runs.get("control-basic");
	expect(familyIds.filter((id) => run?.notImplemented.includes(id))).toEqual([]);
});

test("control fixtures produce zero perf-framework findings", () => {
	expect(controls).toContain("control-next");
	for (const name of controls) {
		const findings = familyEmissions(runs.get(name), owned).filter((e) => e.kind === "finding");
		expect(`${name}: ${findings.map((f) => `${f.rule} ${f.path} ${f.locator}`).join("; ")}`).toBe(`${name}: `);
	}
});

test("the family's do-not-flag notes appear where do-not-flag.md says they are planted", () => {
	expect(PLANTED_PERF_DNF).toEqual([]);
	const missing: string[] = [];
	for (const id of NOTES) {
		const fixture = catalogue.dnf.get(id)?.plantedIn.match(/^test\/fixtures\/([^/]+)\//)?.[1] ?? "";
		if (!runs.get(fixture)?.emissions.some((e) => e.rule === id && e.kind === "dnf-note")) missing.push(`${id} in ${fixture}`);
	}
	expect(missing).toEqual([]);
});

test("control-next is the Next.js control do-not-flag.md describes", () => {
	const dir = join(FIXTURES_DIR, "control-next");
	for (const f of ["app/layout.tsx", "app/old/page.tsx"]) expect(existsSync(join(dir, f))).toBe(true);
	for (const f of ["app/robots.ts", "app/sitemap.ts", "app/robots.txt", "app/sitemap.xml"]) expect(existsSync(join(dir, f))).toBe(false);
	const old = runs.get("control-next")?.emissions.find((e) => e.rule === "DNF-18");
	expect([old?.path, old?.observed.startsWith("307 /old -> /new")]).toEqual(["/old", true]);
});

test("judgment rows in the family each have an occurrence and a silent control", () => {
	const occurrences: Record<string, true> = {};
	const silent: Record<string, true> = {};
	for (const name of names) {
		const file = join(FIXTURES_DIR, name, "expect", `${FAMILY_NAME}.judgment.json`);
		if (!existsSync(file)) continue;
		const rows: { rule: string; silent?: boolean }[] = JSON.parse(readFileSync(file, "utf8"));
		for (const r of rows) (r.silent ? silent : occurrences)[r.rule] = true;
	}
	expect(judgmentIds.filter((id) => !occurrences[id] || !silent[id])).toEqual([]);
});

test("field values and planted lab values are recorded-only, each with its live counterpart", () => {
	const wrong: string[] = [];
	for (const name of names) {
		const occ = loadExpect(name, FAMILY_NAME);
		const editsFile = join(FIXTURES_DIR, name, "lhr-edits.json");
		const edits: { edits: { path: string }[] } = existsSync(editsFile) ? JSON.parse(readFileSync(editsFile, "utf8")) : { edits: [] };
		const edited = edits.edits.map((e) => e.path);
		for (const o of occ) {
			const recordedOnly = FIELD_VALUE_RULES[o.rule] || edited.includes(`audits.${LAB_METRIC_AUDIT[o.rule] ?? ""}.numericValue`);
			if (recordedOnly && JSON.stringify(o.modes) !== '["recorded"]') wrong.push(`${name} ${o.rule} ${o.path}: modes ${JSON.stringify(o.modes)}`);
			if (FIELD_VALUE_RULES[o.rule] && !occ.some((x) => x.rule === "CWV-010" && x.path === o.path && JSON.stringify(x.modes) === '["live"]'))
				wrong.push(`${name} ${o.rule} ${o.path}: no live CWV-010 counterpart`);
		}
	}
	expect(wrong).toEqual([]);
});

test("lhr-edits.json lists only numericValue paths, and lhr.json holds the planted values", () => {
	let fixtures = 0;
	for (const name of names) {
		const editsFile = join(FIXTURES_DIR, name, "lhr-edits.json");
		if (!existsSync(editsFile)) continue;
		fixtures++;
		const lhr: Json = JSON.parse(readFileSync(join(FIXTURES_DIR, name, "lhr.json"), "utf8"));
		const edits: { edits: { path: string; planted: number }[] } = JSON.parse(readFileSync(editsFile, "utf8"));
		for (const e of edits.edits) {
			expect(e.path).toMatch(/^audits\.[a-z0-9-]+\.numericValue$/);
			let v: Json | undefined = lhr;
			for (const k of e.path.split(".")) v = typeof v === "object" && v !== null && !Array.isArray(v) ? v[k] : undefined;
			expect(v).toBe(e.planted);
		}
		const version = typeof lhr === "object" && lhr !== null && !Array.isArray(lhr) ? lhr.lighthouseVersion : null;
		expect(String(version).split(".")[0]).toBe("13");
	}
	expect(fixtures).toBeGreaterThan(0);
});

describe("source text detectors", () => {
	test("object entries skip braces and commas inside strings, templates and comments", () => {
		const text = 'x = { title: "a, {b}", /* c: 1, */ d: `e ${"}"} f`, g: { h: [1, 2] }, i, "j-k": \'l\' }';
		const entries = objectEntries(text, text.indexOf("{"));
		expect(entries.map((e) => [e.key, e.value])).toEqual([
			["title", '"a, {b}"'],
			["d", '`e ${"}"} f`'],
			["g", "{ h: [1, 2] }"],
			["i", ""],
			["j-k", "'l'"],
		]);
		expect(stringValue('"a, {b}"')).toBe("a, {b}");
		expect(stringValue('`e ${"}"} f`')).toBeNull();
	});

	test("array elements split at top-level commas only", () => {
		const text = 'x = { images: ["/a.png", { url: "/b.png", alt: "c, d" }] }';
		const images = objectEntries(text, text.indexOf("{")).find((e) => e.key === "images");
		expect(images ? arrayElements(text, images).map((e) => e.value) : []).toEqual(['"/a.png"', '{ url: "/b.png", alt: "c, d" }']);
	});

	test("the 'use client' directive counts only as the first statement", () => {
		const file = (text: string) => ({ path: "app/page.tsx", bytes: text.length, text });
		expect(isClientFile(file("// a comment\n/* another */\n'use client';\nexport const metadata = {};"))).toBe(true);
		expect(isClientFile(file('import x from "y";\n"use client";'))).toBe(false);
	});

	test("metadata exports: the const object and each object generateMetadata returns", () => {
		const text = [
			"export const metadata: Metadata = { title: 'A' };",
			"export async function generateMetadata({ params }: Props): Promise<Metadata> {",
			"  if (x) return { title: 'B' };",
			"  return { description: '}' };",
			"}",
		].join("\n");
		const ex = metadataExports({ path: "app/page.tsx", bytes: text.length, text });
		expect(ex.map((e) => [e.kind, e.objects.map((o) => o.entries.map((x) => x.key).join(","))])).toEqual([
			["metadata", ["title"]],
			["generateMetadata", ["title", "description"]],
		]);
	});
});
