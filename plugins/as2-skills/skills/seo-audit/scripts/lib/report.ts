// Writes the run's three outputs: evidence.json (everything collected; long strings and arrays trimmed for size, the
// rules having already read the full values), findings.json (the engine's emissions) and report.md (the report
// contract in SKILL.md: the verdict line, findings by severity, observations, Not checked, do-not-flag notes).
// Every file the audit writes (these three, --record-rendered recordings, --record-lhr) goes through writeContained.
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Emission, EngineResult } from "./engine.ts";
import type { Evidence } from "./evidence.ts";

// A write the containment rules refuse: a symlinked destination file, or one inside the audited project.
export class WriteRefused extends Error {}

function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

// The real path of `p`, which may not exist yet: its nearest existing ancestor resolved through symlinks, the missing
// tail appended as given. A symlink on the way whose target does not exist is refused (WriteRefused): a write through
// it lands at that target, which cannot be resolved, so it is never mistaken for a missing path component.
export function realpathOf(p: string): string {
	const tail: string[] = [];
	let at = resolve(p);
	for (;;) {
		try {
			return join(realpathSync(at), ...tail);
		} catch {
			if (isSymlink(at)) throw new WriteRefused(`${at} is a symlink whose target does not exist`);
			const parent = dirname(at);
			if (parent === at) return resolve(p);
			tail.unshift(basename(at));
			at = parent;
		}
	}
}

// True when `p` is `repo` or inside it, after both are resolved through symlinks.
export function isInside(repo: string, p: string): boolean {
	const rel = relative(realpathOf(repo), realpathOf(p));
	return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

// The open's no-symlink flag. On darwin O_NOFOLLOW_ANY (0x20000000, sys/fcntl.h and `man 2 open`; node:fs does not
// export it) refuses a symlink in any path component, the leaf included; darwin answers EINVAL when it is combined
// with O_NOFOLLOW, so it replaces it. Linux has no such flag: O_NOFOLLOW covers the leaf, and writeAt re-checks the
// opened descriptor's path for the ancestors.
const NO_SYMLINK = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;

const refusedInside = (file: string, repo: string) => new WriteRefused(`${file} is inside the audited project ${repo}; outputs never go there`);

// Writes `data` to `realPath`, a path whose directory has already been resolved through symlinks and found outside
// `repo`. The open never follows a symlink (NO_SYMLINK): on darwin in no component, so an ancestor swapped for a
// symlink after the check fails the open; on Linux not at the leaf, and the opened descriptor's real path
// (/proc/self/fd) is checked against `repo` before anything is written. An existing file with another hard link is
// refused too (fstat nlink), since that other name may be inside `repo`. The file is truncated only after the open
// and those checks, so a refused write leaves an existing file's contents untouched.
export function writeAt(realPath: string, data: string, repo: string | null, shown: string = realPath): void {
	if (isSymlink(realPath)) throw new WriteRefused(`${shown} is a symlink; outputs are never written through one`);
	let fd: number;
	try {
		fd = openSync(realPath, constants.O_WRONLY | constants.O_CREAT | NO_SYMLINK, 0o644);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "EMLINK")
			throw new WriteRefused(`${shown}: a component of its path is a symlink at write time; outputs are never written through one`);
		throw e;
	}
	try {
		if (repo && process.platform === "linux" && isInside(repo, readlinkSync(`/proc/self/fd/${fd}`))) throw refusedInside(shown, repo);
		if (fstatSync(fd).nlink > 1) throw new WriteRefused(`${shown} has another hard link; outputs are never written through one`);
		ftruncateSync(fd, 0);
		writeSync(fd, data);
	} finally {
		closeSync(fd);
	}
}

// Writes `data` to `file`, creating its directory. Refuses (WriteRefused) when `file` is a symlink, dangling or not,
// since the write would land at its target; and, when `repo` is given, when the real path of the file's directory is
// the audited project or inside it. That is checked before the directory is created (so a refused write creates
// nothing) and again on the created directory's real path, which writeAt then opens without following any symlink.
export function writeContained(file: string, data: string, repo: string | null): void {
	const dir = dirname(resolve(file));
	if (repo && isInside(repo, dir)) throw refusedInside(file, repo);
	mkdirSync(dir, { recursive: true });
	const realDir = realpathSync(dir);
	if (repo && isInside(repo, realDir)) throw refusedInside(file, repo);
	writeAt(join(realDir, basename(file)), data, repo, file);
}

export interface Verdict {
	date: string;
	target: string;
	critical: number;
	high: number;
	medium: number;
	low: number;
	observations: number;
	verdict: "clean" | "findings" | "incomplete";
}

export function verdictOf(evidence: Evidence, result: EngineResult): Verdict {
	const count = (s: string) => result.emissions.filter((e) => e.kind === "finding" && e.severity === s).length;
	const findings = result.emissions.filter((e) => e.kind === "finding").length;
	return {
		date: evidence.auditTime.slice(0, 10),
		target: evidence.targets.join(" "),
		critical: count("critical"),
		high: count("high"),
		medium: count("medium"),
		low: count("low"),
		observations: result.emissions.filter((e) => e.kind === "observation").length,
		verdict: evidence.incomplete.length ? "incomplete" : findings ? "findings" : "clean",
	};
}

export function verdictLine(v: Verdict): string {
	return `<!-- seo-audit-verdict: date=${v.date} target=${v.target} critical=${v.critical} high=${v.high} medium=${v.medium} low=${v.low} observations=${v.observations} verdict=${v.verdict} -->`;
}

const STRING_CAP = 200_000;
const ARRAY_CAP = 2_000;

function trim(_key: string, value: unknown): unknown {
	if (typeof value === "string" && value.length > STRING_CAP)
		return `${value.slice(0, STRING_CAP)}… [trimmed in evidence.json: ${value.length} characters]`;
	if (Array.isArray(value) && value.length > ARRAY_CAP)
		return [...value.slice(0, ARRAY_CAP), `… [trimmed in evidence.json: ${value.length} items]`];
	return value;
}

function md(s: string): string {
	return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function block(e: Emission): string {
	return [
		`- **${e.rule}** (${e.kind}${e.severity ? `, ${e.severity}` : ""}, layer ${e.layer}) — ${e.url}`,
		`  - locator: \`${md(e.locator)}\``,
		...(e.count > 1 ? [`  - count: ${e.count} (samples: ${e.samples.map((s) => `\`${md(s)}\``).join(", ")})`] : []),
		`  - observed: ${md(e.observed)}`,
		`  - fix: ${md(e.fix)}`,
		`  - source: ${e.sourceUrl} — "${md(e.quote)}"`,
	].join("\n");
}

export function renderReport(evidence: Evidence, result: EngineResult): string {
	const v = verdictOf(evidence, result);
	const out: string[] = [verdictLine(v), "", `# seo-audit report: ${evidence.targets.join(", ")}`, ""];
	out.push(`Audit time ${evidence.auditTime}. Mechanical rules only; the judgment rules in references/rules.md are applied by the agent (SKILL.md step 3).`, "");
	if (evidence.incomplete.length) {
		out.push("**Incomplete:** a mandatory layer failed, so the verdict cannot be clean.", "");
		for (const r of evidence.incomplete) out.push(`- ${md(r)}`);
		out.push("");
	}
	out.push("## Findings by severity", "");
	const findings = result.emissions.filter((e) => e.kind === "finding");
	if (!findings.length) out.push("No mechanical findings.", "");
	for (const sev of ["critical", "high", "medium", "low"]) {
		const list = findings.filter((e) => e.severity === sev);
		if (!list.length) continue;
		out.push(`### ${sev[0]?.toUpperCase()}${sev.slice(1)} (${list.length})`, "", ...list.map(block), "");
	}
	out.push("## Observations", "");
	const obs = result.emissions.filter((e) => e.kind === "observation");
	out.push(...(obs.length ? obs.map(block) : ["None."]), "");
	out.push("## Not checked", "");
	for (const n of evidence.notChecked) out.push(`- ${md(n.item)}: ${md(n.reason)}`);
	if (result.notImplemented.length)
		out.push(`- mechanical rules with no rule module yet (not evaluated): ${result.notImplemented.join(", ")}`);
	out.push("");
	out.push("## Do-not-flag notes that fired", "");
	const notes = result.emissions.filter((e) => e.kind === "dnf-note");
	out.push(
		...(notes.length
			? notes.map((e) => `- **${e.rule}** — ${e.url} (\`${md(e.locator)}\`${e.count > 1 ? `, ${e.count} occurrences` : ""}): ${md(e.observed)}. ${md(e.fix)} Source: ${e.sourceUrl} — "${md(e.quote)}"`)
			: ["None."]),
		"",
	);
	return out.join("\n");
}

export function writeOutputs(
	dir: string,
	evidence: Evidence,
	result: EngineResult,
	repo: string | null,
): { evidence: string; findings: string; report: string } {
	const paths = { evidence: join(dir, "evidence.json"), findings: join(dir, "findings.json"), report: join(dir, "report.md") };
	writeContained(paths.evidence, `${JSON.stringify(evidence, trim, "\t")}\n`, repo);
	const v = verdictOf(evidence, result);
	writeContained(
		paths.findings,
		`${JSON.stringify({ verdict: v, modules: result.modules, notImplemented: result.notImplemented, emissions: result.emissions }, null, "\t")}\n`,
		repo,
	);
	writeContained(paths.report, renderReport(evidence, result), repo);
	return paths;
}
