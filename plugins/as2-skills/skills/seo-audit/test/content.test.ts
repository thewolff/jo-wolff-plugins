// Fixture tests for the content rule family (scripts/rules/content.ts): rules.md categories title, snippet, headings,
// images, links, mobile, international, site, javascript and page-experience, plus the family's do-not-flag notes.
// Every fixture under test/fixtures/ is served on its loopback port and audited offline from its recorded rendered
// pages; the family's emissions must equal the fixture's expect/content.json as a multiset of (rule, path, locator,
// kind, severity, layer). Judgment rows are scored by the human-run acceptance from expect/content.judgment.json; this
// file checks that each has a planted occurrence and a silent control. Re-record with
// `bun skills/seo-audit/test/record-fixtures.ts content-page content-tls`.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalogue } from "../scripts/lib/catalogue.ts";
import { type AuditRun, FIXTURES_DIR, auditFixture, compareOccurrences, familyEmissions, fixtureNames, loadExpect } from "./harness.ts";

const FAMILY_NAME = "content";
const FAMILY: Record<string, true> = {
	title: true,
	snippet: true,
	headings: true,
	images: true,
	links: true,
	mobile: true,
	international: true,
	site: true,
	javascript: true,
	"page-experience": true,
};
const NOTES = ["DNF-01", "DNF-02", "DNF-03", "DNF-04", "DNF-05", "DNF-06", "DNF-12", "DNF-17", "HEU-06"];
const CONTROLS = ["control-basic", "control-sitemap", "control-intent"];

interface JudgmentEntry {
	rule: string;
	path: string;
	locator?: string;
	kind?: string;
	severity?: string | null;
	silent?: true;
}

const catalogue = loadCatalogue();
const rows = [...catalogue.rules.values()].filter((r) => FAMILY[r.category]);
const familyIds = rows.filter((r) => r.mode === "mechanical").map((r) => r.id);
const judgmentIds = rows.filter((r) => r.mode === "judgment").map((r) => r.id);
const owned: Record<string, true> = Object.fromEntries([...familyIds, ...NOTES].map((id) => [id, true] as const));
const names = fixtureNames();
const runs = new Map<string, AuditRun>();

function loadJudgment(name: string): JudgmentEntry[] {
	const file = join(FIXTURES_DIR, name, "expect", `${FAMILY_NAME}.judgment.json`);
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as JudgmentEntry[]) : [];
}

beforeAll(async () => {
	const done = await Promise.all(names.map(async (n) => [n, await auditFixture(n)] as const));
	for (const [n, r] of done) runs.set(n, r);
}, 50_000);

describe("fixtures match expect/content.json", () => {
	for (const name of names) {
		test(name, () => {
			const run = runs.get(name);
			expect(run?.stderr ?? "").not.toContain("seo-audit failed");
			expect(run?.code).toBe(0);
			expect(compareOccurrences(loadExpect(name, FAMILY_NAME), familyEmissions(run, owned), "recorded")).toEqual({ missing: [], unexpected: [] });
		});
	}
});

test("every mechanical content rule is planted in some expect/content.json", () => {
	expect(familyIds.length).toBeGreaterThan(0);
	const planted: Record<string, true> = {};
	for (const name of names) for (const o of loadExpect(name, FAMILY_NAME)) if (o.kind !== "dnf-note") planted[o.rule] = true;
	expect(familyIds.filter((id) => !planted[id])).toEqual([]);
});

test("the engine implements every mechanical content rule", () => {
	const run = runs.get("control-basic");
	expect(run?.emissions.length).toBeGreaterThan(0);
	expect(familyIds.filter((id) => run?.notImplemented.includes(id))).toEqual([]);
});

test("content controls produce zero content findings", () => {
	for (const name of CONTROLS) {
		const findings = familyEmissions(runs.get(name), owned).filter((e) => e.kind === "finding");
		expect(`${name}: ${findings.map((f) => `${f.rule} ${f.path} ${f.locator}`).join("; ")}`).toBe(`${name}: `);
	}
});

// The family's do-not-flag notes appear in the fixture do-not-flag.md names in its planted-in column.
test("the family's do-not-flag notes appear where do-not-flag.md says they are planted", () => {
	const missing: string[] = [];
	for (const id of NOTES) {
		const fixture = catalogue.dnf.get(id)?.plantedIn.match(/^test\/fixtures\/([^/]+)\//)?.[1] ?? "";
		if (!runs.get(fixture)?.emissions.some((e) => e.rule === id && e.kind === "dnf-note")) missing.push(`${id} in ${fixture}`);
	}
	expect(missing).toEqual([]);
});

test("every judgment content row has a planted occurrence and a silent control", () => {
	expect(judgmentIds.length).toBeGreaterThan(0);
	const occurrence: Record<string, true> = {};
	const silent: Record<string, true> = {};
	const malformed: string[] = [];
	for (const name of names)
		for (const j of loadJudgment(name)) {
			if (!judgmentIds.includes(j.rule)) malformed.push(`${name}: ${j.rule} is not a judgment row of this family`);
			else if (j.silent) silent[j.rule] = true;
			else {
				const row = catalogue.rules.get(j.rule);
				if (!j.locator || j.kind !== row?.kind || j.severity !== row?.severity) malformed.push(`${name}: ${j.rule} ${j.path} needs locator, kind ${row?.kind}, severity ${row?.severity}`);
				occurrence[j.rule] = true;
			}
		}
	expect(malformed).toEqual([]);
	expect(judgmentIds.filter((id) => !occurrence[id]).map((id) => `${id}: no occurrence`)).toEqual([]);
	expect(judgmentIds.filter((id) => !silent[id]).map((id) => `${id}: no silent control`)).toEqual([]);
});

// Intent: a content finding on an intent-noindex URL becomes an observation (every row in the family is `observe`).
// control-intent's /private carries the half-empty title "Committee minutes |" (TTL-005) and is passed with --intent noindex.
test("intent noindex turns TTL-005 on control-intent's private page into an observation", () => {
	const intent = (runs.get("control-intent")?.emissions ?? []).filter((e) => e.rule === "TTL-005");
	expect(intent.map((e) => [e.path, e.kind, e.severity])).toEqual([["/private", "observation", null]]);
	expect(runs.get("control-intent")?.verdict).toBe("clean");
});
