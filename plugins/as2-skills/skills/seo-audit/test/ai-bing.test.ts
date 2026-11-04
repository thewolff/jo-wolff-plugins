// Fixture tests for the AI search and Bing rule family (scripts/rules/ai-bing.ts): rules.md categories ai-policy,
// ai-search, ai-access, llms-txt and bing, plus the family's do-not-flag notes, and the judgment rows of ai-search, bing
// and spam. Every fixture under test/fixtures/ is served on its loopback port (UA probes get per-UA answers from
// `_serve.json` `ua` entries) and audited offline from its recorded rendered pages; the family's emissions must equal
// the fixture's expect/ai-bing.json as a multiset. Judgment occurrences live in expect/ai-bing.judgment.json and are
// scored at acceptance; here each judgment row only has to have an occurrence and a silent control.
// Re-record with `bun skills/seo-audit/test/record-fixtures.ts`.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalogue } from "../scripts/lib/catalogue.ts";
import { type AuditRun, FIXTURES_DIR, auditFixture, compareOccurrences, familyEmissions, fixtureNames, loadExpect } from "./harness.ts";

const FAMILY_NAME = "ai-bing";
const FAMILY: Record<string, true> = { "ai-policy": true, "ai-search": true, "ai-access": true, "llms-txt": true, bing: true };
const JUDGMENT_FAMILY: Record<string, true> = { "ai-search": true, bing: true, spam: true };
const NOTES = ["DNF-15", "AI-003", "AI-021", "NF-AI-2", "NF-AI-10", "NF-BNG-4", "NF-03", "NF-AI-1"];
const CONTROLS = ["control-basic", "control-sitemap", "control-intent", "control-ai-policy"];
// do-not-flag.md "must also satisfy": control-ai-policy's training and user-fetch disallows are observations.
const POLICY_OBSERVATIONS = ["AI-002", "AI-011", "AI-012", "AI-035", "AI-061", "AI-070", "AI-075"];

interface JudgmentEntry {
	rule: string;
	path: string;
	locator?: string;
	kind?: string;
	severity?: string | null;
	silent?: true;
}

const catalogue = loadCatalogue();
const familyIds = [...catalogue.rules.values()].filter((r) => FAMILY[r.category] && r.mode === "mechanical").map((r) => r.id);
const judgmentRows = [...catalogue.rules.values()].filter((r) => JUDGMENT_FAMILY[r.category] && r.mode === "judgment");
const owned: Record<string, true> = Object.fromEntries([...familyIds, ...NOTES].map((id) => [id, true] as const));
const names = fixtureNames();
const runs = new Map<string, AuditRun>();

const judgments: { fixture: string; entry: JudgmentEntry }[] = names.flatMap((fixture) => {
	const file = join(FIXTURES_DIR, fixture, "expect", `${FAMILY_NAME}.judgment.json`);
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as JudgmentEntry[]).map((entry) => ({ fixture, entry })) : [];
});

beforeAll(async () => {
	const done = await Promise.all(names.map(async (n) => [n, await auditFixture(n)] as const));
	for (const [n, r] of done) runs.set(n, r);
}, 50_000);

describe("fixtures match expect/ai-bing.json", () => {
	for (const name of names) {
		test(name, () => {
			const run = runs.get(name);
			expect(run?.stderr ?? "").not.toContain("seo-audit failed");
			expect(run?.code).toBe(0);
			expect(compareOccurrences(loadExpect(name, FAMILY_NAME), familyEmissions(run, owned), "recorded")).toEqual({ missing: [], unexpected: [] });
		});
	}
});

test("every mechanical ai-bing rule is planted in some expect/ai-bing.json", () => {
	expect(familyIds.length).toBeGreaterThan(0);
	const planted = new Set(names.flatMap((name) => loadExpect(name, FAMILY_NAME).map((o) => o.rule)));
	expect(familyIds.filter((id) => !planted.has(id))).toEqual([]);
});

test("the engine implements every mechanical ai-bing rule", () => {
	const run = runs.get("control-basic");
	expect(familyIds.filter((id) => run?.notImplemented.includes(id))).toEqual([]);
});

test("controls produce zero ai-bing findings", () => {
	for (const name of CONTROLS) {
		const findings = familyEmissions(runs.get(name), owned).filter((e) => e.kind === "finding");
		expect(`${name}: ${findings.map((f) => `${f.rule} ${f.path} ${f.locator}`).join("; ")}`).toBe(`${name}: `);
	}
});

test("control-ai-policy's training and user-fetch disallows are observations", () => {
	const policy = familyEmissions(runs.get("control-ai-policy"), owned);
	expect(POLICY_OBSERVATIONS.filter((id) => !policy.some((e) => e.rule === id && e.kind === "observation"))).toEqual([]);
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

test("every ai-search, bing and spam judgment row has an occurrence and a silent control", () => {
	expect(judgmentRows.length).toBeGreaterThan(0);
	const lacking: string[] = [];
	for (const row of judgmentRows) {
		const mine = judgments.filter((j) => j.entry.rule === row.id);
		const hits = mine.filter((j) => !j.entry.silent);
		if (!hits.length) lacking.push(`${row.id}: no occurrence`);
		if (!mine.some((j) => j.entry.silent)) lacking.push(`${row.id}: no silent control`);
		for (const { fixture, entry } of hits)
			if (entry.kind !== row.kind || entry.severity !== row.severity || !entry.locator) lacking.push(`${row.id} in ${fixture}: ${entry.kind}/${entry.severity} at ${entry.locator}`);
	}
	expect(lacking).toEqual([]);
	expect(judgments.filter((j) => !JUDGMENT_FAMILY[catalogue.rules.get(j.entry.rule)?.category ?? ""]).map((j) => j.entry.rule)).toEqual([]);
});

// Review r1 finding 4: a crawler reads robots.txt for every URL it fetches, so a redirect to a path disallowed for
// bingbot (same origin, or another origin with its own robots.txt) keeps Bing from the audited URL.
test("BNG-001 finds an audited URL whose redirect target robots.txt disallows", () => {
	for (const name of ["crawl-robots-redirect", "crawl-robots-redirect-xo"])
		expect(familyEmissions(runs.get(name), owned).filter((e) => e.rule === "BNG-001").map((e) => `${name} ${e.path} ${e.locator} ${e.kind}`)).toEqual([
			`${name} /start robots.txt:line:2 finding`,
		]);
});
