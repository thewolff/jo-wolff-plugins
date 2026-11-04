// The rule engine. Rule modules are discovered from scripts/rules/*.ts; each exports `rules` (and optionally `notes`),
// keyed by rules.md id (or do-not-flag.md id). A check returns hits; the engine attaches kind, severity, fix, source and
// quote from the catalogue, applies `--intent noindex=<url>` through each row's intent-effect, and lists every
// mechanical rules.md row that no module implements, so coverage is visible in findings.json and report.md.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Catalogue, type Layer, type RuleRow, type Severity, SKILL_DIR, loadCatalogue } from "./catalogue.ts";
import type { Evidence, PageEvidence, SiteEvidence } from "./evidence.ts";
import { robotsVerdict } from "./robots.ts";
import { clip, normaliseUrl, pathOf } from "./url.ts";

export const RULES_DIR = join(SKILL_DIR, "scripts", "rules");

// One thing a check found. `url` is the resource the locator points into (a page, robots.txt, a sitemap); `observed`
// is the receipt, clipped to 300 characters by the engine. `cause`, when set, names the root cause: hits of one rule
// with the same url, layer and cause collapse into one emission (the first hit's locator and receipt, a count and
// the first SAMPLES locators), so one misconfiguration repeated over a 50,000-entry sitemap is one finding.
export interface Hit {
	url: string;
	locator: string;
	layer: Layer;
	observed: string;
	cause?: string;
}

export interface RuleContext {
	evidence: Evidence;
	auditTime: Date;
	audited: PageEvidence[];
	page(url: string): PageEvidence | undefined;
	site(url: string): SiteEvidence | undefined;
	isIntentNoindex(url: string): boolean;
	// RFC 9309 verdict for Googlebot (or `tokens`, most specific first) on the URL's own origin; null when that origin's
	// robots.txt was not fetched with a 2xx.
	robotsAllowed(url: string, tokens?: string[]): boolean | null;
}

export type Check = (ctx: RuleContext) => Hit[];

export interface RuleModule {
	rules: Record<string, Check>;
	notes?: Record<string, Check>;
}

export interface Emission {
	rule: string;
	kind: "finding" | "observation" | "dnf-note";
	severity: Severity | null;
	layer: Layer;
	url: string;
	path: string;
	locator: string;
	observed: string;
	count: number; // hits this emission stands for: 1, or more when hits shared a `cause`
	samples: string[]; // the first SAMPLES locators of those hits, in the order the check returned them
	category: string;
	fix: string;
	sourceUrl: string;
	quote: string;
}

const SAMPLES = 5;

interface Collapsed {
	hit: Hit;
	count: number;
	samples: string[];
}

// Hits with a `cause` merge per (url, layer, cause), keeping the first hit's position; hits without one stand alone.
function collapse(hits: Hit[]): Collapsed[] {
	const out: Collapsed[] = [];
	const byCause = new Map<string, Collapsed>();
	for (const hit of hits) {
		if (hit.cause === undefined) {
			out.push({ hit, count: 1, samples: [hit.locator] });
			continue;
		}
		const key = `${hit.url}\u0000${hit.layer}\u0000${hit.cause}`;
		const group = byCause.get(key);
		if (group) {
			group.count++;
			if (group.samples.length < SAMPLES) group.samples.push(hit.locator);
			continue;
		}
		const fresh = { hit, count: 1, samples: [hit.locator] };
		byCause.set(key, fresh);
		out.push(fresh);
	}
	return out;
}

export interface EngineResult {
	emissions: Emission[];
	notImplemented: string[];
	modules: string[];
}

function isCheckRecord(v: unknown): v is Record<string, Check> {
	return typeof v === "object" && v !== null && Object.values(v).every((f) => typeof f === "function");
}

export async function discoverModules(dir: string = RULES_DIR): Promise<{ name: string; module: RuleModule }[]> {
	const out: { name: string; module: RuleModule }[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file.endsWith(".test.ts") || file.startsWith("_")) continue;
		// Runtime-selected on purpose: rule families are discovered from the directory, so a new family needs no
		// registration edit here (binding decision for parallel family slices).
		const mod: Record<string, unknown> = await import(join(dir, file));
		if (!isCheckRecord(mod.rules)) throw new Error(`scripts/rules/${file} must export \`rules\`: a record of checks`);
		if (mod.notes !== undefined && !isCheckRecord(mod.notes)) throw new Error(`scripts/rules/${file}: \`notes\` must be a record of checks`);
		out.push({ name: file, module: { rules: mod.rules, notes: isCheckRecord(mod.notes) ? mod.notes : undefined } });
	}
	return out;
}

export function makeContext(evidence: Evidence): RuleContext {
	const pages = new Map<string, PageEvidence>();
	for (const p of evidence.pages) {
		const k = normaliseUrl(p.url);
		if (k && !pages.has(k)) pages.set(k, p);
	}
	// An intent URL covers the page it names and the final URL that page redirected to.
	const intent = new Set(evidence.intentNoindex.map((u) => normaliseUrl(u)).filter((u): u is string => u !== null));
	for (const p of evidence.pages) {
		const k = normaliseUrl(p.url);
		const final = normaliseUrl(p.fetch.finalUrl);
		if (p.role === "audited" && k && intent.has(k) && final) intent.add(final);
	}
	const site = (url: string) => {
		try {
			const origin = new URL(url).origin;
			return evidence.sites.find((s) => s.origin === origin);
		} catch {
			return undefined;
		}
	};
	return {
		evidence,
		auditTime: new Date(evidence.auditTime),
		audited: evidence.pages.filter((p) => p.role === "audited"),
		page: (url) => {
			const k = normaliseUrl(url);
			return k ? pages.get(k) : undefined;
		},
		site,
		isIntentNoindex: (url) => {
			const k = normaliseUrl(url);
			return k !== null && intent.has(k);
		},
		robotsAllowed: (url, tokens = ["Googlebot"]) => {
			const parsed = site(url)?.robots.parsed;
			return parsed ? robotsVerdict(parsed, tokens, pathOf(url)).allowed : null;
		},
	};
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const KIND_RANK: Record<string, number> = { finding: 0, observation: 1, "dnf-note": 2 };

function emit(row: RuleRow | null, id: string, { hit, count, samples }: Collapsed, ctx: RuleContext, cat: Catalogue): Emission {
	if (row) {
		if (!row.layers.includes(hit.layer)) throw new Error(`${id}: hit layer ${hit.layer} is not one of the row's layers (${row.layers.join(", ")})`);
		const observe = row.kind === "finding" && row.intentEffect === "observe" && ctx.isIntentNoindex(hit.url);
		return {
			rule: id,
			kind: observe ? "observation" : row.kind,
			severity: observe ? null : row.severity,
			layer: hit.layer,
			url: hit.url,
			path: pathOf(hit.url),
			locator: hit.locator,
			observed: clip(hit.observed),
			count,
			samples,
			category: row.category,
			fix: row.fix,
			sourceUrl: row.sourceUrl,
			quote: row.quote,
		};
	}
	const note = cat.dnf.get(id);
	if (!note) throw new Error(`${id}: not a do-not-flag.md row`);
	return {
		rule: id,
		kind: "dnf-note",
		severity: null,
		layer: hit.layer,
		url: hit.url,
		path: pathOf(hit.url),
		locator: hit.locator,
		observed: clip(hit.observed),
		count,
		samples,
		category: "do-not-flag",
		fix: note.instead,
		sourceUrl: note.sourceUrl,
		quote: note.quote,
	};
}

export async function runRules(evidence: Evidence, modules?: { name: string; module: RuleModule }[]): Promise<EngineResult> {
	const cat = loadCatalogue();
	const mods = modules ?? (await discoverModules());
	const ctx = makeContext(evidence);
	const emissions: Emission[] = [];
	const implemented = new Set<string>();
	for (const { name, module } of mods) {
		for (const [id, check] of Object.entries(module.rules)) {
			const row = cat.rules.get(id);
			if (!row) throw new Error(`scripts/rules/${name}: ${id} is not a rules.md row`);
			if (row.mode !== "mechanical") throw new Error(`scripts/rules/${name}: ${id} is a judgment row; only mechanical rows have modules`);
			if (implemented.has(id)) throw new Error(`scripts/rules/${name}: ${id} is implemented by two modules`);
			implemented.add(id);
			for (const c of collapse(check(ctx))) emissions.push(emit(row, id, c, ctx, cat));
		}
		for (const [id, check] of Object.entries(module.notes ?? {})) {
			if (implemented.has(id)) throw new Error(`scripts/rules/${name}: note ${id} is implemented by two modules`);
			implemented.add(id);
			for (const c of collapse(check(ctx))) emissions.push(emit(null, id, c, ctx, cat));
		}
	}
	emissions.sort(
		(a, b) =>
			(KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
			(SEVERITY_RANK[a.severity ?? ""] ?? 9) - (SEVERITY_RANK[b.severity ?? ""] ?? 9) ||
			a.rule.localeCompare(b.rule) ||
			a.path.localeCompare(b.path) ||
			a.locator.localeCompare(b.locator),
	);
	const notImplemented = [...cat.rules.values()].filter((r) => r.mode === "mechanical" && !implemented.has(r.id)).map((r) => r.id);
	return { emissions, notImplemented, modules: mods.map((m) => m.name) };
}
