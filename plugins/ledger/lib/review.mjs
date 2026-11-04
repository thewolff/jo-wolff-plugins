// review.mjs — the cross-lab review: run other labs' models over the branch's diff, record one
// cc_reviews row per lab for the HEAD commit, and decide the review gate from those rows.
//
// Rows are keyed by the repository's top-level folder (`cwd`) and the full HEAD sha, so a review
// run from a subfolder and a push from the root see the same rows. Each finding carries a
// severity, `blocking`, `should` or `nit` (untagged → should), kept in `findings_json`. Verdicts:
//   pass            the lab replied PASS
//   pass-with-nits  every finding is a nit
//   findings        at least one blocking or should finding (the markdown is in `findings`)
//   unavailable     the lab could not be run: no binary, non-zero exit, timeout, empty reply (`reason`)
//   addressed       `review addressed "<why>"`: the human-approved override of an earlier commit's findings (lab `ledger`)
//   waived          `review waive "<why>"`: the human let this commit through (lab `ledger`, `reason`)
//
// The state of HEAD (headState), strictest first:
//   waived       any waived row for HEAD                                → allow
//   findings     some lab's latest row is findings, after the last addressed row → deny (gate)
//   addressed    an addressed row for HEAD and no later findings        → allow
//   none         no row for HEAD at all                                 → deny (gate) / notice (advise)
//   unavailable  every lab's latest row is unavailable                  → allow with a notice
//   pass         every other lab passed, some maybe with nits           → allow (notice naming nits and unavailable labs)
//
// `review.mode` (user file only): off → nothing runs; advise → never denies, notices instead;
// gate (default) → denies `none` and `findings`. The state binds to the HEAD sha: a new commit
// needs its own review or waive.
//
// The review loop: every sha on the branch (base..HEAD) that has a lab row is one round, in the
// order they were first reviewed. `review` names the round it runs as; past `review.maxRounds`
// it stops and says to ask the human (waive, or continue with `--force-round`).
//
// The judge (lib/judge.mjs) checks every "this finding is resolved" claim: a blocking or should
// finding from the previous round that a lab no longer lists, and every open finding when the
// agent runs `review addressed "<why>"`. Each is asked once, with the finding and the diff
// between the two shas for the files it names. `no` keeps it open (`judge: "no"` in
// findings_json; the row stays or becomes `findings`, the gate stays closed); `yes` resolves it;
// `unverified` (no judge, or it failed) resolves it fail-open and the gate's notice says so.

import { spawnSync } from "node:child_process";
import { transaction } from "./db.mjs";
import { nowIso } from "./time.mjs";
import { parseItems, severityCounts, which } from "./review/common.mjs";
import { ask as askJudge, judgeCommand, passageFor } from "./judge.mjs";
import * as codex from "./review/codex.mjs";
import * as kimi from "./review/kimi.mjs";
import * as claude from "./review/claude.mjs";
import * as glm from "./review/glm.mjs";

export const ADAPTERS = Object.freeze({ codex, kimi, claude, glm });
export const REVIEW_TIMEOUT_MS = 240_000;
export const META_LAB = "ledger";
export const DEFAULT_MAX_ROUNDS = 3;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/** { top, head } for the repository `cwd` is in; throws when it is not one or has no commit. */
export function gitHead(cwd) {
  return { top: git(cwd, ["rev-parse", "--show-toplevel"]).trim(), head: git(cwd, ["rev-parse", "HEAD"]).trim() };
}

/**
 * The default base: the merge-base of HEAD with origin/main, else with a local main or master
 * that HEAD has moved past, else HEAD~1.
 */
export function defaultBase(cwd) {
  let head = null;
  try {
    head = git(cwd, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "HEAD~1";
  }
  for (const ref of ["origin/main", "main", "master"]) {
    try {
      const mb = git(cwd, ["merge-base", "HEAD", ref]).trim();
      if (mb && mb !== head) return mb;
    } catch {
      /* no such ref */
    }
  }
  return "HEAD~1";
}

function insertRow(db, dbPath, r) {
  transaction(
    db,
    () => {
      db.prepare("INSERT INTO cc_reviews (session_id, cwd, head_sha, base_ref, lab, model, verdict, findings, findings_json, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
        r.sessionId ?? null,
        r.cwd,
        r.head,
        r.base ?? null,
        r.lab,
        r.model ?? null,
        r.verdict,
        r.findings ?? null,
        r.items?.length ? JSON.stringify(r.items) : null,
        r.reason ?? null,
        r.at,
      );
    },
    dbPath,
  );
}

const short = (sha) => String(sha).slice(0, 8);

/** A row's findings items (from findings_json); [] when none. */
export function rowItems(row) {
  if (!row?.findings_json) return [];
  try {
    return JSON.parse(row.findings_json);
  } catch {
    return [];
  }
}

const countsText = (c) => `${c.blocking} blocking, ${c.should} should, ${c.nit} nit`;

/**
 * The branch's review rounds: one per sha in `base..HEAD` that has a lab row (not waive or
 * addressed), ordered by its first review. @returns {Array<{ round, sha, rows }>}
 */
export function branchRounds(db, top, base) {
  let shas;
  try {
    shas = new Set(git(top, ["rev-list", `${base}..HEAD`]).split("\n").filter(Boolean));
  } catch {
    shas = new Set();
  }
  const groups = new Map();
  for (const r of db.prepare("SELECT * FROM cc_reviews WHERE cwd = ? AND lab <> ? ORDER BY at ASC, id ASC").all(top, META_LAB)) {
    if (!shas.has(r.head_sha)) continue;
    if (!groups.has(r.head_sha)) groups.set(r.head_sha, []);
    groups.get(r.head_sha).push(r);
  }
  return [...groups.entries()].map(([sha, rows], i) => ({ round: i + 1, sha, rows }));
}

/** The round `head` is (or would be) on this branch, and the rounds before it. */
function roundOf(db, top, head, base) {
  const rounds = branchRounds(db, top, base);
  const at = rounds.findIndex((r) => r.sha === head);
  return at >= 0 ? at + 1 : rounds.length + 1;
}

/** The items of a row: findings_json when present, else parsed from its findings text. */
function itemsOf(row) {
  const items = rowItems(row);
  return items.length || !row?.findings ? items : parseItems(row.findings);
}

/** Open blocking and should items. */
const openSerious = (items) => items.filter((i) => !i.resolved && (i.severity === "blocking" || i.severity === "should"));

/** File paths a finding names (`dir/file.ext`, optionally with `:line`). */
export function namedFiles(text) {
  return [...new Set([...String(text).matchAll(/([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)(?::\d+)?/g)].map((m) => m[1].replace(/^\.\//, "")))];
}

const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Whether `item` from an earlier round is still listed among `items` (same text, or same first file and most words shared). */
export function stillListed(item, items) {
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const file = namedFiles(item.text)[0] ?? null;
  const w = words(item.text);
  return items.some((other) => {
    if (norm(other.text) === norm(item.text)) return true;
    if (!file || namedFiles(other.text)[0] !== file) return false;
    const o = words(other.text);
    const shared = [...w].filter((x) => o.has(x)).length;
    return shared / Math.max(1, new Set([...w, ...o]).size) >= 0.5;
  });
}

/** Ask the judge about each item against the change `fromSha..toSha`; returns the items with `judge` (and `resolved` unless `no`). */
async function judgeItems({ db, dbPath, config, env, top, fromSha, toSha, items }) {
  let changed = [];
  try {
    changed = git(top, ["diff", "--name-only", fromSha, toSha]).split("\n").filter(Boolean);
  } catch {
    /* the diff below reports the same failure as no change */
  }
  const out = [];
  for (const item of items) {
    const files = namedFiles(item.text).filter((f) => changed.some((c) => c === f || c.endsWith(`/${f}`) || f.endsWith(`/${c}`)));
    const targets = files.map((f) => changed.find((c) => c === f || c.endsWith(`/${f}`) || f.endsWith(`/${c}`)));
    let diff = "";
    try {
      diff = git(top, ["diff", fromSha, toSha, ...(targets.length ? ["--", ...targets] : [])]);
    } catch {
      diff = "";
    }
    const r = await askJudge({ db, dbPath, config, env, passage: passageFor(`[${item.severity}] ${item.text}`, diff) });
    out.push(r.verdict === "no" ? { ...item, resolved: false, judge: "no" } : { ...item, resolved: true, judge: r.verdict });
  }
  return out;
}

/** The verdict for a set of items: findings when any open blocking/should, pass-with-nits when only open nits, else pass. */
function verdictOf(items) {
  const open = items.filter((i) => !i.resolved);
  if (open.some((i) => i.severity !== "nit")) return "findings";
  return open.length ? "pass-with-nits" : "pass";
}

const itemLine = (i) => `[${i.severity}] ${i.text.split("\n")[0]}`;

/**
 * `ledger review [--base <ref>] [--labs a,b] [--force-round]`: every lab in parallel, one row
 * each for HEAD; refuses a round past review.maxRounds unless forced.
 * @returns {Promise<{ code: number, text: string }>}
 */
export async function runReview({ db, dbPath, cwd, env = process.env, config, labs = null, base = null, forceRound = false, sessionId = null, cli = "ledger", now = () => Date.now(), timeoutMs = REVIEW_TIMEOUT_MS }) {
  let top, head, diff;
  const baseRef = base ?? defaultBase(cwd);
  try {
    ({ top, head } = gitHead(cwd));
    diff = git(top, ["diff", `${baseRef}..HEAD`]);
  } catch (err) {
    return { code: 1, text: `refused ${err.message}; nothing reviewed` };
  }
  const list = labs ?? config.review?.labs ?? ["codex"];
  if (!list.length) return { code: 1, text: "refused review.labs is empty; nothing reviewed" };
  const max = config.review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const round = roundOf(db, top, head, baseRef);
  if (round > max && !forceRound) {
    return {
      code: 1,
      text: `stopped: this would be review round ${round} for this branch, and review.maxRounds is ${max}. Ask the human: waive with their reason (\`${cli} review waive "<why>"\`), or continue with \`${cli} review --force-round\`.`,
    };
  }
  const results = await Promise.allSettled(
    list.map(async (lab) => {
      if (!diff.trim()) return { verdict: "pass", findings: null, items: [], model: null, reason: `empty diff ${baseRef}..HEAD` };
      const adapter = ADAPTERS[lab];
      if (!adapter) throw new Error(`unknown lab ${lab}; supported: ${Object.keys(ADAPTERS).join(", ")}`);
      return adapter.run({ diff, cwd: top, timeoutMs, env, config: config.review ?? {} });
    }),
  );
  const previous = branchRounds(db, top, baseRef).filter((r) => r.sha !== head).at(-1) ?? null;
  const out = [`review of ${short(head)} (${baseRef}..HEAD) in ${top}, round ${round} of ${max}${round > max ? " (forced)" : ""}:`];
  let anyFindings = false;
  for (let i = 0; i < list.length; i++) {
    const lab = list[i];
    const res = results[i];
    let r = res.status === "fulfilled" ? res.value : { verdict: "unavailable", reason: res.reason?.message ?? String(res.reason), model: null, findings: null, items: [] };
    const judged = [];
    if (r.verdict !== "unavailable" && previous) {
      const before = previous.rows.findLast((x) => x.lab === lab && x.verdict === "findings");
      const dropped = before ? openSerious(itemsOf(before)).filter((it) => !stillListed(it, r.items ?? [])) : [];
      if (dropped.length) {
        judged.push(...(await judgeItems({ db, dbPath, config, env, top, fromSha: previous.sha, toSha: head, items: dropped })));
        const items = [...(r.items ?? []), ...judged];
        const stillOpen = judged.filter((it) => it.judge === "no");
        const findings = stillOpen.length ? [r.findings, ...stillOpen.map((it, k) => `${(r.items?.length ?? 0) + k + 1}. ${itemLine(it)} (from round ${previous.round}; the judge says it is not resolved)`)].filter(Boolean).join("\n") : r.findings;
        r = { ...r, items, findings, verdict: verdictOf(items) };
      }
    }
    insertRow(db, dbPath, { sessionId, cwd: top, head, base: baseRef, lab, model: r.model, verdict: r.verdict, findings: r.findings, items: r.items, reason: r.reason ?? null, at: nowIso(now()) });
    const model = r.model ? ` (${r.model})` : "";
    if (r.verdict === "findings") {
      anyFindings = true;
      out.push(`${lab}: findings${model}: ${countsText(severityCounts(r.items))}`, indent(r.findings));
    } else if (r.verdict === "pass-with-nits") out.push(`${lab}: pass with nits${model}: ${countsText(severityCounts(r.items))}`, indent(r.findings));
    else if (r.verdict === "unavailable") out.push(`${lab}: unavailable: ${r.reason}`);
    else out.push(`${lab}: pass${model}${r.reason ? ` · ${r.reason}` : ""}`);
    for (const it of judged) out.push(`  judge ${it.judge}: ${itemLine(it)} (round ${previous.round})`);
  }
  if (anyFindings) {
    out.push(
      round < max
        ? `next: fix the blocking and should findings, commit, and run \`${cli} review\` again (round ${round + 1} of ${max}).`
        : `round ${round} of ${max} reached: ask the human whether to waive (\`${cli} review waive "<why>"\`) or continue with \`${cli} review --force-round\`.`,
    );
  }
  return { code: 0, text: out.join("\n") };
}

function indent(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** `review waive "<why>"`: a waived row for HEAD. */
export function waive({ db, dbPath, cwd, reason, sessionId = null, now = Date.now() }) {
  const why = String(reason ?? "").trim();
  if (!why) return { code: 1, text: 'refused review waive needs the reason: review waive "<why>"' };
  let top, head;
  try {
    ({ top, head } = gitHead(cwd));
  } catch (err) {
    return { code: 1, text: `refused ${err.message}` };
  }
  insertRow(db, dbPath, { sessionId, cwd: top, head, lab: META_LAB, verdict: "waived", reason: why, at: nowIso(now) });
  return { code: 0, text: `waived the review gate for ${short(head)}: ${why}` };
}

/**
 * `review addressed "<why>"`: the manual override of a finding, for HEAD, only after a findings
 * row on an earlier commit here; the reason is required. The judge checks each open blocking or
 * should finding of that commit against the change since: any `no` records a findings row for
 * HEAD naming it (the gate stays closed) and refuses; otherwise an addressed row is recorded,
 * carrying the judged findings, `unverified` ones named.
 */
export async function addressed({ db, dbPath, cwd, reason, config = {}, env = process.env, sessionId = null, now = Date.now() }) {
  const why = String(reason ?? "").trim();
  if (!why) return { code: 1, text: 'refused review addressed needs the reason: review addressed "<why the findings no longer apply>"' };
  let top, head;
  try {
    ({ top, head } = gitHead(cwd));
  } catch (err) {
    return { code: 1, text: `refused ${err.message}` };
  }
  const prior = db.prepare("SELECT head_sha FROM cc_reviews WHERE cwd = ? AND verdict = 'findings' AND head_sha <> ? ORDER BY at DESC, id DESC LIMIT 1").get(top, head);
  if (!prior) return { code: 1, text: `refused no review findings on an earlier commit in ${top}; commit the fixes first, or waive with the human's reason` };
  const labRows = headState(db, top, prior.head_sha).labRows.filter((r) => r.verdict === "findings");
  const judgedByLab = [];
  for (const row of labRows) {
    const items = openSerious(itemsOf(row));
    judgedByLab.push({ row, items: await judgeItems({ db, dbPath, config, env, top, fromSha: prior.head_sha, toSha: head, items }) });
  }
  const at = nowIso(now);
  const rejected = judgedByLab.filter(({ items }) => items.some((i) => i.judge === "no"));
  if (rejected.length) {
    const out = [`refused the judge says these findings on ${short(prior.head_sha)} are not resolved by ${short(head)}; the gate stays closed:`];
    for (const { row, items } of rejected) {
      const open = items.filter((i) => i.judge === "no");
      insertRow(db, dbPath, {
        sessionId,
        cwd: top,
        head,
        base: row.base_ref,
        lab: row.lab,
        model: row.model,
        verdict: "findings",
        findings: open.map((i, k) => `${k + 1}. ${itemLine(i)}`).join("\n"),
        items,
        reason: `addressed claimed: ${why}; the judge said no`,
        at,
      });
      for (const i of open) out.push(`${row.lab}: ${itemLine(i)}`);
    }
    return { code: 1, text: out.join("\n") };
  }
  const all = judgedByLab.flatMap(({ items }) => items);
  const unverified = all.filter((i) => i.judge === "unverified");
  const note = unverified.length ? `; ${unverified.length} unverified by the judge` : "";
  insertRow(db, dbPath, { sessionId, cwd: top, head, lab: META_LAB, verdict: "addressed", items: all, reason: `${why} (findings on ${short(prior.head_sha)}${note})`, at });
  const out = [`recorded ${short(head)} as addressing the findings on ${short(prior.head_sha)}: ${why}`];
  for (const i of all) out.push(`  judge ${i.judge}: ${itemLine(i)}`);
  return { code: 0, text: out.join("\n") };
}

/** The review state of `head` in repository `top` (see the table at the top of this file). */
export function headState(db, top, head) {
  const rows = db.prepare("SELECT * FROM cc_reviews WHERE cwd = ? AND head_sha = ? ORDER BY at ASC, id ASC").all(top, head);
  const waivedRow = rows.findLast((r) => r.verdict === "waived");
  const lastAddressed = rows.findLast((r) => r.verdict === "addressed");
  const latest = new Map();
  for (const r of rows) if (r.lab !== META_LAB) latest.set(r.lab, r);
  const labRows = [...latest.values()];
  const findings = labRows.filter((r) => r.verdict === "findings" && (!lastAddressed || r.at > lastAddressed.at || (r.at === lastAddressed.at && r.id > lastAddressed.id)));
  const nits = labRows.filter((r) => r.verdict === "pass-with-nits");
  const unavailable = labRows.filter((r) => r.verdict === "unavailable");
  const unverifiedFrom = (row) => rowItems(row).filter((i) => i.judge === "unverified");
  const unverified = [...(lastAddressed ? unverifiedFrom(lastAddressed) : []), ...labRows.flatMap(unverifiedFrom)];
  const base = { rows, labRows, findings, nits, unavailable, unverified, head, top };
  if (waivedRow) return { ...base, kind: "waived", reason: waivedRow.reason };
  if (findings.length) return { ...base, kind: "findings" };
  if (lastAddressed) return { ...base, kind: "addressed" };
  if (!labRows.length) return { ...base, kind: "none" };
  if (unavailable.length === labRows.length) return { ...base, kind: "unavailable" };
  return { ...base, kind: "pass" };
}

const unavailableText = (rows) => rows.map((r) => `${r.lab} unavailable: ${r.reason}`).join("; ");
const grouped = (rows) => rows.map((r) => `${r.lab}${r.model ? ` (${r.model})` : ""}:\n${r.findings}`).join("\n\n");

/**
 * The gate's answer for `state` under `mode`: { deny: reason } | { notice: line } | {} (silent allow).
 */
export function gateDecision(state, mode, cli = "ledger") {
  if (mode === "off") return {};
  const sha = short(state.head);
  const unverifiedText = state.unverified?.length ? `${state.unverified.length} finding(s) counted as resolved but unverified by the judge: ${state.unverified.map(itemLine).join("; ")}` : "";
  if (state.kind === "waived") return {};
  if (state.kind === "addressed") return unverifiedText ? { notice: `ledger: review addressed for ${sha}; ${unverifiedText}` } : {};
  if (state.kind === "findings") {
    const msg = `ledger: the cross-lab review found problems in ${sha}. Fix the blocking and should findings, commit, and run \`${cli} review\` again; to override a finding that does not apply, \`${cli} review addressed "<why>"\` after committing; if the human wants to push anyway, record their words with \`${cli} review waive "<their reason>"\`.\n\n${grouped(state.findings)}`;
    return mode === "gate" ? { deny: msg } : { notice: msg };
  }
  if (state.kind === "none") {
    const msg = `ledger: no cross-lab review for ${sha}; run \`${cli} review\` before pushing (if the human says they are prototyping or need the push anyway, run \`${cli} review waive "<their reason>"\`).`;
    return mode === "gate" ? { deny: msg } : { notice: msg };
  }
  if (state.kind === "unavailable") return { notice: `ledger: review gate open for ${sha}: every lab was unavailable (${unavailableText(state.unavailable)})` };
  const parts = [];
  if (state.unavailable.length) parts.push(unavailableText(state.unavailable));
  if (unverifiedText) parts.push(unverifiedText);
  if (state.nits.length) parts.push(`nits, optional:\n\n${grouped(state.nits)}`);
  return parts.length ? { notice: `ledger: review passed for ${sha}; ${parts.join("; ")}` } : {};
}

/** `review status`: the gate state for HEAD, the branch's rounds, then HEAD's own rows. */
export function status({ db, cwd, config, cli = "ledger" }) {
  let top, head;
  try {
    ({ top, head } = gitHead(cwd));
  } catch (err) {
    return { code: 1, text: `refused ${err.message}` };
  }
  const state = headState(db, top, head);
  const mode = config.review?.mode ?? "gate";
  const max = config.review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const d = gateDecision(state, mode, cli);
  const verdict = d.deny ? "would deny a push" : d.notice ? "allows a push, with a notice" : "allows a push";
  const out = [`review of ${short(head)} in ${top}: ${state.kind}; review.mode ${mode} ${mode === "off" ? "(gate off)" : verdict}`];
  const rounds = branchRounds(db, top, defaultBase(cwd));
  if (rounds.length) {
    out.push(`rounds on this branch (review.maxRounds ${max}):`, "round  sha       lab      blocking  should  nit  verdict");
    for (const { round, sha, rows } of rounds) {
      for (const r of rows) {
        const c = severityCounts(rowItems(r));
        out.push(`${String(round).padStart(5)}  ${short(sha)}  ${r.lab.padEnd(7)}  ${String(c.blocking).padStart(8)}  ${String(c.should).padStart(6)}  ${String(c.nit).padStart(3)}  ${r.verdict}`);
      }
    }
  }
  if (!state.rows.length) out.push(`no review rows for ${short(head)}; run \`${cli} review\``);
  else out.push(`rows for ${short(head)}:`);
  for (const r of state.rows) {
    out.push(`${r.at}  ${r.lab.padEnd(7)} ${r.verdict}${r.model ? ` (${r.model})` : ""}${r.reason ? ` · ${r.reason}` : ""}`);
    if (r.findings) out.push(indent(r.findings));
  }
  return { code: 0, text: out.join("\n") };
}

/** The SessionStart line: HEAD's open blocking and should findings summed across labs; "" when none, mode off, or not a repo. */
export function findingsLine(db, cwd, config, cli = "ledger") {
  if ((config.review?.mode ?? "gate") === "off") return "";
  let state;
  try {
    const { top, head } = gitHead(cwd);
    state = headState(db, top, head);
  } catch {
    return "";
  }
  if (state.kind !== "findings") return "";
  const n = state.findings.reduce((s, r) => {
    const c = severityCounts(itemsOf(r));
    return s + c.blocking + c.should;
  }, 0);
  return `ledger: cross-lab review found ${n} finding(s) on ${short(state.head)}; run \`${cli} review status\``;
}

/**
 * Doctor checks, none when mode is off: each configured lab's binary is present (warn per
 * missing), and a judge is configured (warn when not: addressed claims go unverified).
 */
export function labChecks(cfg, env = process.env) {
  const review = cfg.config.review ?? {};
  if (review.mode === "off") return [];
  const labs = (review.labs ?? []).map((lab) => {
    const adapter = ADAPTERS[lab];
    if (!adapter) return { status: "warn", name: `review ${lab}`, text: `unknown lab; supported: ${Object.keys(ADAPTERS).join(", ")}`, detail: [] };
    const bin = env[`LEDGER_REVIEW_BIN_${lab.toUpperCase()}`] || adapter.defaultBin;
    const found = which(bin, env);
    return found
      ? { status: "ok", name: `review ${lab}`, text: `${bin} found at ${found}`, detail: [] }
      : { status: "warn", name: `review ${lab}`, text: `${bin} not found on PATH; \`ledger review\` will record ${lab} as unavailable`, detail: [] };
  });
  const judge = judgeCommand(cfg.config, env);
  labs.push(
    judge.command
      ? { status: "ok", name: "judge", text: `from ${judge.source}`, detail: [] }
      : { status: "warn", name: "judge", text: "no review.judgeCommand and no i-have-audhd enforcement.judgeCommand: addressed claims unverified", detail: [] },
  );
  return labs;
}
