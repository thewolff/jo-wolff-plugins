// Whole-run rule-to-fixture accounting (PLAN section 4, test/coverage.test.ts). Every fixture under test/fixtures/ is
// served on its loopback port and audited offline once; the family tests compare their own slice of the emissions, and
// this file checks what no single family can:
// - each fixture's full emissions equal the union of its expect/<family>.json files, so every emission belongs to a
//   family file and no family file is stale;
// - every emitted id is a rules.md or do-not-flag.md id;
// - every mechanical rules.md id is planted in some expect file, every judgment id has a planted occurrence and a silent
//   control in some expect/<family>.judgment.json;
// - every do-not-flag row planted in a fixture names a control whose expect files carry its dnf-note;
// - every control-* fixture has zero findings from any family and verdict `clean`.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalogue } from "../scripts/lib/catalogue.ts";
import { type AuditRun, FIXTURES_DIR, auditFixture, compareOccurrences, fixtureNames, loadExpect } from "./harness.ts";

interface JudgmentEntry {
	rule: string;
	path: string;
	locator?: string;
	kind?: string;
	severity?: string | null;
	silent?: true;
}

const catalogue = loadCatalogue();
const rows = [...catalogue.rules.values()];
const mechanicalIds = rows.filter((r) => r.mode === "mechanical").map((r) => r.id);
const judgmentIds = rows.filter((r) => r.mode === "judgment").map((r) => r.id);
const names = fixtureNames();
const controls = names.filter((n) => n.startsWith("control-"));
const runs = new Map<string, AuditRun>();

function loadJudgment(name: string): { file: string; entries: JudgmentEntry[] }[] {
	const dir = join(FIXTURES_DIR, name, "expect");
	if (!existsSync(dir)) return [];
	return [...new Bun.Glob("*.judgment.json").scanSync(dir)].sort().map((f) => ({
		file: `${name}/expect/${f}`,
		entries: JSON.parse(readFileSync(join(dir, f), "utf8")) as JudgmentEntry[],
	}));
}

function findings(name: string): string[] {
	return (runs.get(name)?.emissions ?? []).filter((e) => e.kind === "finding").map((e) => `${e.rule} ${e.path} ${e.locator}`);
}

beforeAll(async () => {
	const done = await Promise.all(names.map(async (n) => [n, await auditFixture(n)] as const));
	for (const [n, r] of done) runs.set(n, r);
}, 50_000);

describe("every emission on a fixture is in exactly one of its expect/<family>.json files", () => {
	for (const name of names) {
		test(name, () => {
			const run = runs.get(name);
			expect(run?.stderr ?? "").not.toContain("seo-audit failed");
			expect(run?.code).toBe(0);
			expect(compareOccurrences(loadExpect(name), run?.emissions ?? [], "recorded")).toEqual({ missing: [], unexpected: [] });
		});
	}
});

test("every emitted rule id is a rules.md or do-not-flag.md id", () => {
	const unknown: string[] = [];
	for (const name of names)
		for (const e of runs.get(name)?.emissions ?? []) if (!catalogue.rules.has(e.rule) && !catalogue.dnf.has(e.rule)) unknown.push(`${name}: ${e.rule}`);
	expect(unknown).toEqual([]);
});

test("every mechanical rules.md id is planted in some expect/<family>.json", () => {
	expect(mechanicalIds.length).toBeGreaterThan(0);
	const planted = new Set<string>();
	for (const name of names) for (const o of loadExpect(name)) if (o.kind !== "dnf-note") planted.add(o.rule);
	expect(mechanicalIds.filter((id) => !planted.has(id))).toEqual([]);
});

test("every judgment rules.md id has a planted occurrence and a silent control in some expect/<family>.judgment.json", () => {
	expect(judgmentIds.length).toBeGreaterThan(0);
	const occurrence = new Set<string>();
	const silent = new Set<string>();
	const malformed: string[] = [];
	for (const name of names)
		for (const { file, entries } of loadJudgment(name))
			for (const j of entries) {
				const row = catalogue.rules.get(j.rule);
				if (row?.mode !== "judgment") malformed.push(`${file}: ${j.rule} is not a judgment row`);
				else if (j.silent) silent.add(j.rule);
				else if (!j.locator || j.kind !== row.kind || j.severity !== row.severity)
					malformed.push(`${file}: ${j.rule} ${j.path} needs locator, kind ${row.kind}, severity ${row.severity}`);
				else occurrence.add(j.rule);
			}
	expect(malformed).toEqual([]);
	expect(judgmentIds.filter((id) => !occurrence.has(id)).map((id) => `${id}: no occurrence`)).toEqual([]);
	expect(judgmentIds.filter((id) => !silent.has(id)).map((id) => `${id}: no silent control`)).toEqual([]);
});

test("every do-not-flag row planted in a fixture names a control that carries its dnf-note and no finding", () => {
	const planted = [...catalogue.dnf.values()].flatMap((r) => {
		const fixture = r.plantedIn.match(/^test\/fixtures\/([^/]+)\//)?.[1];
		return fixture ? [{ id: r.id, fixture }] : [];
	});
	expect(planted.length).toBeGreaterThan(0);
	const wrong: string[] = [];
	for (const { id, fixture } of planted) {
		if (!controls.includes(fixture)) wrong.push(`${id}: ${fixture} is not a control-* fixture`);
		else if (!loadExpect(fixture).some((o) => o.rule === id && o.kind === "dnf-note")) wrong.push(`${id}: no dnf-note in ${fixture}/expect`);
		else if (findings(fixture).length) wrong.push(`${id}: ${fixture} has findings`);
	}
	expect(wrong).toEqual([]);
});

describe("every control has zero findings from any family and verdict clean", () => {
	test("there are controls", () => {
		expect(controls.length).toBeGreaterThanOrEqual(3);
	});
	for (const name of controls) {
		test(name, () => {
			expect(`${name}: ${findings(name).join("; ")}`).toBe(`${name}: `);
			expect(runs.get(name)?.verdict).toBe("clean");
		});
	}
});
