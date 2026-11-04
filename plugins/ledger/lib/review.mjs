// review.mjs — the cross-lab review: run other labs' models over the branch's diff, record one
// cc_reviews row per lab for the HEAD commit, and decide the review gate from those rows.
//
// Rows are keyed by the repository's top-level folder (`cwd`) and the full HEAD sha, so a review
// run from a subfolder and a push from the root see the same rows. Verdicts:
//   pass         the lab replied PASS
//   findings     the lab replied with findings (the markdown is in `findings`)
//   unavailable  the lab could not be run: no binary, non-zero exit, timeout, empty reply (`reason`)
//   addressed    `review addressed`: the findings of an earlier commit were dealt with (lab `ledger`)
//   waived       `review waive "<why>"`: the human let this commit through (lab `ledger`, `reason`)
//
// The state of HEAD (headState), strictest first:
//   waived       any waived row for HEAD                                → allow
//   findings     some lab's latest row is findings, after the last addressed row → deny (gate)
//   addressed    an addressed row for HEAD and no later findings        → allow
//   none         no row for HEAD at all                                 → deny (gate) / notice (advise)
//   unavailable  every lab's latest row is unavailable                  → allow with a notice
//   pass         every other lab passed (unavailable ones are named)    → allow (notice if any unavailable)
//
// `review.mode` (user file only): off → nothing runs; advise → never denies, notices instead;
// gate (default) → denies `none` and `findings`. The state binds to the HEAD sha: a new commit
// needs its own review or waive.

import { spawnSync } from "node:child_process";
import { transaction } from "./db.mjs";
import { nowIso } from "./time.mjs";
import { countFindings, which } from "./review/common.mjs";
import * as codex from "./review/codex.mjs";
import * as kimi from "./review/kimi.mjs";
import * as claude from "./review/claude.mjs";
import * as glm from "./review/glm.mjs";

export const ADAPTERS = Object.freeze({ codex, kimi, claude, glm });
export const REVIEW_TIMEOUT_MS = 240_000;
export const META_LAB = "ledger";

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

/** The default base: the merge-base of HEAD with origin/main, else HEAD~1. */
export function defaultBase(cwd) {
  try {
    return git(cwd, ["merge-base", "HEAD", "origin/main"]).trim();
  } catch {
    return "HEAD~1";
  }
}

function insertRow(db, dbPath, r) {
  transaction(
    db,
    () => {
      db.prepare("INSERT INTO cc_reviews (session_id, cwd, head_sha, base_ref, lab, model, verdict, findings, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        r.sessionId ?? null,
        r.cwd,
        r.head,
        r.base ?? null,
        r.lab,
        r.model ?? null,
        r.verdict,
        r.findings ?? null,
        r.reason ?? null,
        r.at,
      );
    },
    dbPath,
  );
}

const short = (sha) => String(sha).slice(0, 8);

/**
 * `ledger review [--base <ref>] [--labs a,b]`: every lab in parallel, one row each for HEAD.
 * @returns {Promise<{ code: number, text: string }>}
 */
export async function runReview({ db, dbPath, cwd, env = process.env, config, labs = null, base = null, sessionId = null, now = () => Date.now(), timeoutMs = REVIEW_TIMEOUT_MS }) {
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
  const results = await Promise.allSettled(
    list.map(async (lab) => {
      if (!diff.trim()) return { verdict: "pass", findings: null, model: null, reason: `empty diff ${baseRef}..HEAD` };
      const adapter = ADAPTERS[lab];
      if (!adapter) throw new Error(`unknown lab ${lab}; supported: ${Object.keys(ADAPTERS).join(", ")}`);
      return adapter.run({ diff, cwd: top, timeoutMs, env, config: config.review ?? {} });
    }),
  );
  const out = [`review of ${short(head)} (${baseRef}..HEAD) in ${top}:`];
  results.forEach((res, i) => {
    const lab = list[i];
    const r = res.status === "fulfilled" ? res.value : { verdict: "unavailable", reason: res.reason?.message ?? String(res.reason), model: null, findings: null };
    insertRow(db, dbPath, { sessionId, cwd: top, head, base: baseRef, lab, model: r.model, verdict: r.verdict, findings: r.findings, reason: r.reason ?? null, at: nowIso(now()) });
    if (r.verdict === "findings") out.push(`${lab}: findings${r.model ? ` (${r.model})` : ""}`, indent(r.findings));
    else if (r.verdict === "unavailable") out.push(`${lab}: unavailable: ${r.reason}`);
    else out.push(`${lab}: pass${r.model ? ` (${r.model})` : ""}${r.reason ? ` · ${r.reason}` : ""}`);
  });
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

/** `review addressed`: an addressed row for HEAD, only after a findings row on an earlier commit here. */
export function addressed({ db, dbPath, cwd, sessionId = null, now = Date.now() }) {
  let top, head;
  try {
    ({ top, head } = gitHead(cwd));
  } catch (err) {
    return { code: 1, text: `refused ${err.message}` };
  }
  const prior = db.prepare("SELECT head_sha FROM cc_reviews WHERE cwd = ? AND verdict = 'findings' AND head_sha <> ? ORDER BY at DESC, id DESC LIMIT 1").get(top, head);
  if (!prior) return { code: 1, text: `refused no review findings on an earlier commit in ${top}; commit the fixes first, or waive with the human's reason` };
  insertRow(db, dbPath, { sessionId, cwd: top, head, lab: META_LAB, verdict: "addressed", reason: `findings on ${short(prior.head_sha)} addressed`, at: nowIso(now) });
  return { code: 0, text: `recorded ${short(head)} as addressing the findings on ${short(prior.head_sha)}` };
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
  const unavailable = labRows.filter((r) => r.verdict === "unavailable");
  const base = { rows, labRows, findings, unavailable, head, top };
  if (waivedRow) return { ...base, kind: "waived", reason: waivedRow.reason };
  if (findings.length) return { ...base, kind: "findings" };
  if (lastAddressed) return { ...base, kind: "addressed" };
  if (!labRows.length) return { ...base, kind: "none" };
  if (unavailable.length === labRows.length) return { ...base, kind: "unavailable" };
  return { ...base, kind: "pass" };
}

const unavailableText = (rows) => rows.map((r) => `${r.lab} unavailable: ${r.reason}`).join("; ");

/**
 * The gate's answer for `state` under `mode`: { deny: reason } | { notice: line } | {} (silent allow).
 */
export function gateDecision(state, mode, cli = "ledger") {
  if (mode === "off") return {};
  const sha = short(state.head);
  if (state.kind === "waived" || state.kind === "addressed") return {};
  if (state.kind === "findings") {
    const grouped = state.findings.map((r) => `${r.lab}${r.model ? ` (${r.model})` : ""}:\n${r.findings}`).join("\n\n");
    const msg = `ledger: the cross-lab review found problems in ${sha}. Fix them, commit, run \`${cli} review\` again (or \`${cli} review addressed\` once the fixes are committed); if the human wants to push anyway, record their words with \`${cli} review waive "<their reason>"\`.\n\n${grouped}`;
    return mode === "gate" ? { deny: msg } : { notice: msg };
  }
  if (state.kind === "none") {
    const msg = `ledger: no cross-lab review for ${sha}; run \`${cli} review\` before pushing (if the human says they are prototyping or need the push anyway, run \`${cli} review waive "<their reason>"\`).`;
    return mode === "gate" ? { deny: msg } : { notice: msg };
  }
  if (state.kind === "unavailable") return { notice: `ledger: review gate open for ${sha}: every lab was unavailable (${unavailableText(state.unavailable)})` };
  if (state.unavailable.length) return { notice: `ledger: review passed for ${sha}; ${unavailableText(state.unavailable)}` };
  return {};
}

/** `review status`: the gate state and every row for HEAD, oldest first. */
export function status({ db, cwd, config, cli = "ledger" }) {
  let top, head;
  try {
    ({ top, head } = gitHead(cwd));
  } catch (err) {
    return { code: 1, text: `refused ${err.message}` };
  }
  const state = headState(db, top, head);
  const mode = config.review?.mode ?? "gate";
  const d = gateDecision(state, mode, cli);
  const verdict = d.deny ? "would deny a push" : d.notice ? "allows a push, with a notice" : "allows a push";
  const out = [`review of ${short(head)} in ${top}: ${state.kind}; review.mode ${mode} ${mode === "off" ? "(gate off)" : verdict}`];
  if (!state.rows.length) out.push(`no review rows for ${short(head)}; run \`${cli} review\``);
  for (const r of state.rows) {
    out.push(`${r.at}  ${r.lab.padEnd(7)} ${r.verdict}${r.model ? ` (${r.model})` : ""}${r.reason ? ` · ${r.reason}` : ""}`);
    if (r.findings) out.push(indent(r.findings));
  }
  return { code: 0, text: out.join("\n") };
}

/** The SessionStart line: HEAD's open findings summed across labs; "" when none, mode off, or not a repo. */
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
  const n = state.findings.reduce((s, r) => s + countFindings(r.findings), 0);
  return `ledger: cross-lab review found ${n} finding(s) on ${short(state.head)}; run \`${cli} review status\``;
}

/** Doctor checks: each configured lab's binary is present (warn per missing); none when mode is off. */
export function labChecks(cfg, env = process.env) {
  const review = cfg.config.review ?? {};
  if (review.mode === "off") return [];
  return (review.labs ?? []).map((lab) => {
    const adapter = ADAPTERS[lab];
    if (!adapter) return { status: "warn", name: `review ${lab}`, text: `unknown lab; supported: ${Object.keys(ADAPTERS).join(", ")}`, detail: [] };
    const bin = env[`LEDGER_REVIEW_BIN_${lab.toUpperCase()}`] || adapter.defaultBin;
    const found = which(bin, env);
    return found
      ? { status: "ok", name: `review ${lab}`, text: `${bin} found at ${found}`, detail: [] }
      : { status: "warn", name: `review ${lab}`, text: `${bin} not found on PATH; \`ledger review\` will record ${lab} as unavailable`, detail: [] };
  });
}
