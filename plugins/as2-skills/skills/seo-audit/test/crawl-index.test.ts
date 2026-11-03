// Fixture tests for the crawl/index rule family (scripts/rules/crawl-index.ts): rules.md categories robots, indexing,
// canonical, http and sitemap, plus the family's do-not-flag notes. Every fixture under test/fixtures/ is served on its
// loopback port and audited offline from its recorded rendered pages; the family's emissions must equal the fixture's
// expect/crawl-index.json as a multiset of (rule, path, locator, kind, severity, layer). Other families' emissions are
// their own tests' business. Re-record with `bun skills/seo-audit/test/record-fixtures.ts`.
import { beforeAll, describe, expect, test } from "bun:test";
import { loadCatalogue } from "../scripts/lib/catalogue.ts";
import { type AuditRun, auditFixture, compareOccurrences, familyEmissions, fixtureNames, loadExpect } from "./harness.ts";

const FAMILY_NAME = "crawl-index";
const FAMILY: Record<string, true> = { robots: true, indexing: true, canonical: true, http: true, sitemap: true };
const NOTES = ["DNF-07", "DNF-08", "DNF-10", "DNF-11", "DNF-16", "DNF-25", "NF-BNG-1", "NF-BNG-3"];
const CONTROLS = ["control-basic", "control-sitemap", "control-intent"];

const catalogue = loadCatalogue();
const familyIds = [...catalogue.rules.values()].filter((r) => FAMILY[r.category] && r.mode === "mechanical").map((r) => r.id);
const owned: Record<string, true> = Object.fromEntries([...familyIds, ...NOTES].map((id) => [id, true] as const));
const names = fixtureNames();
const runs = new Map<string, AuditRun>();

beforeAll(async () => {
	const done = await Promise.all(names.map(async (n) => [n, await auditFixture(n)] as const));
	for (const [n, r] of done) runs.set(n, r);
}, 50_000);

describe("fixtures match expect/crawl-index.json", () => {
	for (const name of names) {
		test(name, () => {
			const run = runs.get(name);
			expect(run?.stderr ?? "").not.toContain("seo-audit failed");
			expect(run?.code).toBe(0);
			expect(compareOccurrences(loadExpect(name, FAMILY_NAME), familyEmissions(run, owned), "recorded")).toEqual({ missing: [], unexpected: [] });
		});
	}
});

test("every mechanical crawl/index rule is planted in some expect/crawl-index.json", () => {
	expect(familyIds.length).toBeGreaterThan(0);
	const planted: Record<string, true> = {};
	for (const name of names) for (const o of loadExpect(name, FAMILY_NAME)) planted[o.rule] = true;
	expect(familyIds.filter((id) => !planted[id])).toEqual([]);
});

test("the engine implements every mechanical crawl/index rule", () => {
	const run = runs.get("control-basic");
	expect(familyIds.filter((id) => run?.notImplemented.includes(id))).toEqual([]);
});

test("crawl/index controls produce zero crawl/index findings", () => {
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

test("intent noindex turns IDX-001 into an observation and keeps IDX-002/IDX-003 findings", () => {
	const intent = runs.get("control-intent")?.emissions ?? [];
	expect(intent.filter((e) => e.rule === "IDX-001").map((e) => [e.path, e.kind])).toEqual([["/private", "observation"]]);
	const keep = runs.get("intent-keep")?.emissions ?? [];
	expect(keep.filter((e) => e.rule === "IDX-002" || e.rule === "IDX-003").map((e) => e.kind)).toEqual(["finding", "finding"]);
	expect(keep.filter((e) => e.rule === "IDX-001" || e.rule === "RBT-012").map((e) => e.kind)).toEqual(["observation", "observation"]);
});

// Review r1 finding 4: a crawler reads robots.txt for every URL it fetches, so a redirect to a disallowed path (same
// origin, or another origin with its own robots.txt) keeps Googlebot from the audited URL.
test("robots verdicts follow redirects: a disallowed redirect target is RBT-012 (and IDX-002 when it carries noindex)", () => {
	const want: Record<string, string[]> = {
		"crawl-robots-redirect": ["IDX-002 /blocked html:meta[name=robots] finding", "RBT-012 /start robots.txt:line:2 finding"],
		"crawl-robots-redirect-xo": ["RBT-012 /start robots.txt:line:2 finding"],
	};
	for (const [name, hits] of Object.entries(want))
		expect(
			familyEmissions(runs.get(name), owned)
				.filter((e) => e.rule === "RBT-012" || e.rule === "IDX-002")
				.map((e) => `${e.rule} ${e.path} ${e.locator} ${e.kind}`)
				.sort(),
		).toEqual(hits);
});

// Review r1 finding 6: PLAN section 3 makes the robots fetch a mandatory layer, and a 5xx or 429 is a failed fetch.
test("a robots.txt 5xx makes the verdict incomplete and is still reported as RBT-002", () => {
	const run = runs.get("crawl-robots-5xx");
	expect(run?.verdict).toBe("incomplete");
	expect(familyEmissions(run, owned).filter((e) => e.rule === "RBT-002").map((e) => `${e.path} ${e.kind}`)).toEqual(["/robots.txt finding"]);
});
