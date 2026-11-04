// Fixture tests for the structured-data and social rule family (scripts/rules/sd-social.ts): rules.md categories
// structured-data and social, plus the family's do-not-flag notes. Every fixture under test/fixtures/ is served on its
// loopback port and audited offline from its recorded rendered pages; the family's emissions must equal the fixture's
// expect/sd-social.json as a multiset of (rule, path, locator, kind, severity, layer). Judgment rows are scored by the
// human-run acceptance; this file only checks that each has a planted occurrence and a silent control in some
// expect/sd-social.judgment.json. Re-record with `bun skills/seo-audit/test/record-fixtures.ts`.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalogue } from "../scripts/lib/catalogue.ts";
import { type AuditRun, auditFixture, compareOccurrences, FIXTURES_DIR, familyEmissions, fixtureNames, loadExpect, loadServe } from "./harness.ts";

const FAMILY_NAME = "sd-social";
const FAMILY: Record<string, true> = { "structured-data": true, social: true };
const NOTES = ["SD-JLD-07", "NF-01", "NF-02", "NF-06", "NF-07", "NF-10", "DNF-21"];
const CONTROLS = ["control-basic", "control-sitemap", "control-intent", "control-graph", "control-spa"];

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

describe("fixtures match expect/sd-social.json", () => {
	for (const name of names) {
		test(name, () => {
			const run = runs.get(name);
			expect(run?.stderr ?? "").not.toContain("seo-audit failed");
			expect(run?.code).toBe(0);
			expect(compareOccurrences(loadExpect(name, FAMILY_NAME), familyEmissions(run, owned), "recorded")).toEqual({ missing: [], unexpected: [] });
		});
	}
});

test("every mechanical structured-data and social rule is planted in some expect/sd-social.json", () => {
	expect(familyIds.length).toBeGreaterThan(0);
	const planted: Record<string, true> = {};
	for (const name of names) for (const o of loadExpect(name, FAMILY_NAME)) planted[o.rule] = true;
	expect(familyIds.filter((id) => !planted[id])).toEqual([]);
});

test("the engine implements every mechanical structured-data and social rule", () => {
	const run = runs.get("control-basic");
	expect(familyIds.filter((id) => run?.notImplemented.includes(id))).toEqual([]);
});

test("controls produce zero structured-data and social findings", () => {
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

test("every judgment row has a planted occurrence and a silent control in expect/sd-social.judgment.json", () => {
	expect(judgmentIds.length).toBeGreaterThan(0);
	const entries = names.flatMap((name) => loadJudgment(name).map((e) => ({ ...e, fixture: name })));
	for (const e of entries) {
		expect(judgmentIds).toContain(e.rule);
		const audited = loadServe(join(FIXTURES_DIR, e.fixture)).audit.urls.map((u) => new URL(u).pathname);
		expect(audited).toContain(e.path);
	}
	const lacking = judgmentIds.flatMap((id) => {
		const mine = entries.filter((e) => e.rule === id);
		const occurrence = mine.find((e) => !e.silent && e.locator && e.kind && e.severity !== undefined);
		return [...(occurrence ? [] : [`${id}: no occurrence`]), ...(mine.some((e) => e.silent) ? [] : [`${id}: no silent control`])];
	});
	expect(lacking).toEqual([]);
});
