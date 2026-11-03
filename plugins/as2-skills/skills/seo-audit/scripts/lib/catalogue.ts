// Reads the rule catalogue at runtime: references/rules.md and references/do-not-flag.md ship beside scripts/, and
// they are the only source of each rule's kind, severity, layers, intent-effect, fix, source URL and quote. Nothing
// here duplicates those values.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SKILL_DIR = join(import.meta.dir, "..", "..");
export const REFERENCES_DIR = join(SKILL_DIR, "references");

export type Layer =
	| "raw-html"
	| "rendered"
	| "headers"
	| "robots"
	| "sitemap"
	| "structured-data"
	| "lab"
	| "field"
	| "ua-probe"
	| "source"
	| "site";
export type Severity = "critical" | "high" | "medium" | "low";
export type Kind = "finding" | "observation";

export interface RuleRow {
	id: string;
	category: string;
	requirement: string;
	check: string;
	layers: Layer[];
	mode: "mechanical" | "judgment";
	appliesWhen: string;
	intentEffect: "observe" | "keep";
	kind: Kind;
	severity: Severity | null;
	fix: string;
	sourceUrl: string;
	quote: string;
	detectionBasis: string;
}

export interface DnfRow {
	id: string;
	doNotFlag: string;
	instead: string;
	sourceUrl: string;
	quote: string;
	plantedIn: string;
}

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
] as const;
const DNF_COLS = ["id", "do not flag", "instead", "source URL", "quote", "planted-in"] as const;
type RuleCells = Record<(typeof RULE_COLS)[number], string>;
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

// One markdown table row into cells; `\|` inside a cell is an escaped pipe, not a separator.
function cells(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	return s.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll("\\|", "|"));
}

// The rows of the first table whose header is exactly `cols`, keyed by column name.
export function markdownTable<const C extends string>(text: string, cols: readonly C[]): Record<C, string>[] {
	const lines = text.split("\n");
	const at = lines.findIndex(
		(l, n) => l.startsWith("|") && SEP.test(lines[n + 1] ?? "") && cells(l).join("\u0000") === cols.join("\u0000"),
	);
	if (at < 0) throw new Error(`no table with columns: ${cols.join(" | ")}`);
	const out: Record<C, string>[] = [];
	for (const l of lines.slice(at + 2)) {
		if (!l.startsWith("|")) break;
		const c = cells(l);
		if (c.length !== cols.length) throw new Error(`row has ${c.length} cells, expected ${cols.length}: ${l.slice(0, 120)}`);
		const row = {} as Record<C, string>;
		cols.forEach((k, i) => {
			row[k] = c[i] ?? "";
		});
		out.push(row);
	}
	return out;
}

function isLayer(s: string): s is Layer {
	return LAYERS[s] === true;
}

function toRule(r: RuleCells): RuleRow {
	const layers = r.layer.split(",").map((s) => s.trim());
	const bad = layers.filter((l) => !isLayer(l));
	if (bad.length) throw new Error(`${r.id}: unknown layer ${bad.join(", ")}`);
	const mode = r.mode;
	if (mode !== "mechanical" && mode !== "judgment") throw new Error(`${r.id}: mode ${mode}`);
	const intent = r["intent-effect"];
	if (intent !== "observe" && intent !== "keep") throw new Error(`${r.id}: intent-effect ${intent}`);
	const kind = r.kind;
	if (kind !== "finding" && kind !== "observation") throw new Error(`${r.id}: kind ${kind}`);
	const sev = r.severity;
	let severity: Severity | null = null;
	if (kind === "finding") {
		if (sev !== "critical" && sev !== "high" && sev !== "medium" && sev !== "low") throw new Error(`${r.id}: severity ${sev}`);
		severity = sev;
	}
	return {
		id: r.id,
		category: r.category,
		requirement: r.requirement,
		check: r.check,
		layers: layers.filter(isLayer),
		mode,
		appliesWhen: r["applies-when"],
		intentEffect: intent,
		kind,
		severity,
		fix: r.fix,
		sourceUrl: r["source URL"],
		quote: r.quote,
		detectionBasis: r["detection-basis"],
	};
}

export interface Catalogue {
	rules: Map<string, RuleRow>;
	dnf: Map<string, DnfRow>;
}

let cached: Catalogue | null = null;

export function loadCatalogue(dir: string = REFERENCES_DIR): Catalogue {
	if (cached && dir === REFERENCES_DIR) return cached;
	const rules = new Map<string, RuleRow>();
	for (const r of markdownTable(readFileSync(join(dir, "rules.md"), "utf8"), RULE_COLS)) {
		if (rules.has(r.id)) throw new Error(`duplicate rules.md id ${r.id}`);
		rules.set(r.id, toRule(r));
	}
	const dnf = new Map<string, DnfRow>();
	for (const r of markdownTable(readFileSync(join(dir, "do-not-flag.md"), "utf8"), DNF_COLS)) {
		dnf.set(r.id, {
			id: r.id,
			doNotFlag: r["do not flag"],
			instead: r.instead,
			sourceUrl: r["source URL"],
			quote: r.quote,
			plantedIn: r["planted-in"],
		});
	}
	const out = { rules, dnf };
	if (dir === REFERENCES_DIR) cached = out;
	return out;
}
