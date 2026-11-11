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
// The judge (lib/ledger-judge.mjs over the shared lib/judge.mjs) checks every "this finding is resolved" claim: an outstanding
// blocking or should finding (see `outstanding`) that a lab's new reply drops or lists only as a
// nit, and every outstanding finding on an earlier commit when the agent runs `review addressed
// "<why>"`. Each is asked once, with the finding and the diff
// between the two shas for the files it names. `no` keeps it open (`judge: "no"` in
// findings_json; the row stays or becomes `findings`, the gate stays closed); `yes` resolves it;
// `unverified` (no judge, or it failed) resolves it fail-open and the gate's notice says so.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { transaction } from "./db.mjs";
import { logError } from "./failopen.mjs";
import { nowIso } from "./time.mjs";
import { parseItems, receiptSection, severityCounts, which } from "./review/common.mjs";
import { ask as askJudge, judgeCommand, passageFor } from "./ledger-judge.mjs";
import * as codex from "./review/codex.mjs";
import * as kimi from "./review/kimi.mjs";
import * as claude from "./review/claude.mjs";
import * as glm from "./review/glm.mjs";

export const ADAPTERS = Object.freeze({ codex, kimi, claude, glm });
export const REVIEW_TIMEOUT_MS = 240_000;
export const META_LAB = "ledger";
export const DEFAULT_MAX_ROUNDS = 3;
// Every git call has a deadline: the CLI's (a whole-branch diff can take a while) and the hook's,
// well inside the PreToolUse hook's 10-second budget. `gh pr view` (one API call) gets its own.
export const GIT_TIMEOUT_MS = 60_000;
export const HOOK_GIT_TIMEOUT_MS = 3_000;
export const GH_TIMEOUT_MS = 5_000;
// The empty tree: the base of a diff of a branch's root commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.code === "ETIMEDOUT" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : r.error.message}`);
  if (r.status !== 0) {
    const err = new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
    err.gitStatus = r.status;
    err.gitStderr = r.stderr ?? "";
    throw err;
  }
  return r.stdout;
}

/** The error gitHead throws when `cwd` is not in a repository or the repository has no commit. */
export class NotARepository extends Error {}

/**
 * { top, head } for the repository `cwd` is in (head: the full sha, read once). Throws
 * NotARepository when `cwd` is not in one or it has no commit yet; any other failure (git missing,
 * a timeout) throws a plain Error.
 */
export function gitHead(cwd, opts = {}) {
  let top;
  try {
    top = git(cwd, ["rev-parse", "--show-toplevel"], opts).trim();
  } catch (err) {
    if (/not a git repository/i.test(err.gitStderr ?? "")) throw new NotARepository(`${cwd} is not in a git repository`);
    throw err;
  }
  try {
    return { top, head: git(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], opts).trim() };
  } catch (err) {
    if (err.gitStatus === 1) throw new NotARepository(`${top} has no commit yet`);
    throw err;
  }
}

/** The checked-out branch's short name; null when HEAD is detached. */
export function currentBranch(top, opts = {}) {
  try {
    return git(top, ["symbolic-ref", "-q", "--short", "HEAD"], opts).trim() || null;
  } catch {
    return null;
  }
}

/** Every value of git config `key` in `top` (`--get-all`); [] when unset. */
function gitConfig(top, key, opts = {}) {
  try {
    return git(top, ["config", "--get-all", key], opts).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const LS_REMOTE = fileURLToPath(new URL("./ls-remote.mjs", import.meta.url));

/**
 * The environment for a remote lookup from a hook: nothing may prompt. An empty GIT_ASKPASS is
 * taken by git over `core.askPass` and SSH_ASKPASS and runs nothing, GIT_TERMINAL_PROMPT=0 then
 * refuses the terminal; SSH_ASKPASS is dropped and SSH_ASKPASS_REQUIRE=never, and ssh runs with
 * BatchMode=yes (no password, passphrase or host-key question) on the ssh command the repository
 * already uses. ssh keeps the first value it is given for an option, so `-o BatchMode=yes` goes
 * right after the executable, ahead of the command's own options (a `-o BatchMode=no` there
 * loses). lib/ls-remote.mjs adds `-c core.askPass= -c credential.helper=` so no credential
 * helper (a keychain dialog) runs either.
 */
export function quietRemoteEnv(top, env = process.env) {
  const out = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" };
  delete out.SSH_ASKPASS;
  const configured = gitConfig(top, "core.sshCommand", { timeoutMs: HOOK_GIT_TIMEOUT_MS })[0];
  const ssh = env.GIT_SSH_COMMAND || configured || (env.GIT_SSH ? `'${env.GIT_SSH.replace(/'/g, `'\\''`)}'` : "ssh");
  const [, exe, rest] = /^\s*((?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+)(.*)$/s.exec(ssh) ?? [null, ssh, ""];
  out.GIT_SSH_COMMAND = `${exe} -o BatchMode=yes${rest}`;
  delete out.GIT_SSH;
  return out;
}

/**
 * The sha `remote` has at exactly `ref` now: { sha } or { sha: null, why }. `git ls-remote` runs
 * through lib/ls-remote.mjs, which gives it a process group of its own and kills the whole group
 * after GH_TIMEOUT_MS, so no transport helper outlives the hook; nothing can prompt
 * (quietRemoteEnv). Where process groups do not exist only git is killed, and `why` says so.
 */
function lsRemote(top, remote, ref, env = process.env) {
  const r = spawnSync(process.execPath, [LS_REMOTE, remote, ref, String(GH_TIMEOUT_MS)], {
    cwd: top,
    env: quietRemoteEnv(top, env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GH_TIMEOUT_MS + 2_000,
    killSignal: "SIGKILL",
  });
  let res = null;
  try {
    res = JSON.parse(String(r.stdout ?? "").trim().split("\n").at(-1));
  } catch {
    /* reported below */
  }
  if (!res) return { sha: null, why: `git ls-remote ${remote} gave no answer (${r.error ? r.error.message : `exit ${r.status}`})` };
  if (res.timedOut) return { sha: null, why: `git ls-remote ${remote} timed out after ${GH_TIMEOUT_MS / 1000}s${res.group ? "" : " (only git itself could be stopped; its transport helpers may still be running)"}` };
  if (res.error) return { sha: null, why: `git ls-remote ${remote} failed (${res.error})` };
  if (res.status !== 0) return { sha: null, why: `git ls-remote ${remote} could not read it (exit ${res.status})` };
  const line = String(res.stdout ?? "")
    .split("\n")
    .map((l) => l.split("\t"))
    .find(([sha, name]) => name === ref && /^[0-9a-f]{40}$/i.test(sha));
  return line ? { sha: line[0].toLowerCase() } : { sha: null, why: `${remote} has no ${ref}` };
}

/** The commit `ref` names in `top`, as a full sha; throws when it names none. */
function commitOf(top, ref, opts = {}) {
  try {
    return git(top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], opts).trim();
  } catch {
    throw new Error(`${ref} does not name a commit in ${top}`);
  }
}

/**
 * The base of `head`'s branch, as a sha (null: the branch starts at a root commit, diffed against
 * the empty tree). The merge-base with origin/main, else with a local main or master, when it is
 * not `head` itself; else the base the branch's first review recorded (ROOT_BASE for "from the
 * root"), while it is still an ancestor of `head`; else head's parent. Storing the resolved base
 * in every row keeps the round count stable on a branch with no main to measure from.
 */
export function defaultBase(db, top, head, branch) {
  for (const ref of ["origin/main", "main", "master"]) {
    try {
      const mb = git(top, ["merge-base", head, ref]).trim();
      if (mb && mb !== head) return mb;
    } catch {
      /* no such ref, or no common history */
    }
  }
  if (branch) {
    const first = db.prepare("SELECT base_ref FROM cc_reviews WHERE cwd = ? AND branch = ? AND lab <> ? AND base_ref IS NOT NULL ORDER BY at ASC, id ASC LIMIT 1").get(top, branch, META_LAB);
    if (first?.base_ref === ROOT_BASE) return null;
    if (first) {
      try {
        git(top, ["merge-base", "--is-ancestor", first.base_ref, head]);
        return first.base_ref;
      } catch {
        /* the branch was rewritten past its first base */
      }
    }
  }
  try {
    return commitOf(top, `${head}~1`);
  } catch {
    return null;
  }
}

// The base_ref stored for a review whose base is the root (diffed against the empty tree), so a
// branch's later reviews keep counting from the root instead of from the root commit.
export const ROOT_BASE = EMPTY_TREE;

function insertRow(db, dbPath, r) {
  transaction(
    db,
    () => {
      db.prepare("INSERT INTO cc_reviews (session_id, cwd, head_sha, base_ref, branch, lab, model, verdict, findings, findings_json, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
        r.sessionId ?? null,
        r.cwd,
        r.head,
        r.base ?? null,
        r.branch ?? null,
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
 * The branch's review rounds: one per sha in `base..head` (every ancestor of `head` when `base`
 * is null) that has a lab row (not waive or addressed), ordered by its first review.
 * @returns {Array<{ round, sha, rows }>}
 */
export function branchRounds(db, top, base, head) {
  let shas;
  try {
    shas = new Set(git(top, ["rev-list", base ? `${base}..${head}` : head]).split("\n").filter(Boolean));
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

/** The round `head` is (or would be) on this branch. */
function roundOf(rounds, head) {
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

/**
 * Whether `item` from an earlier review is still listed as serious among `items` (same text, or
 * same first file and most words shared). A finding relisted only as a nit counts as dropped: the
 * downgrade goes to the judge like a removal.
 */
export function stillListed(item, items) {
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const file = namedFiles(item.text)[0] ?? null;
  const w = words(item.text);
  return openSerious(items).some((other) => {
    if (norm(other.text) === norm(item.text)) return true;
    if (!file || namedFiles(other.text)[0] !== file) return false;
    const o = words(other.text);
    const shared = [...w].filter((x) => o.has(x)).length;
    return shared / Math.max(1, new Set([...w, ...o]).size) >= 0.5;
  });
}

/**
 * Each lab's outstanding blocking and should findings on this branch: for every lab with a row in
 * `rounds` (the current commit's earlier rows included), its latest row that is not
 * `unavailable`, where a row supersedes the lab's current one only when it is on the same commit
 * or a descendant of it (a later review of an ancestor did not read the descendant's change, so
 * it clears nothing). When that row has open serious items and no `addressed` row came after it
 * on a commit between it and `head`, { lab, row, round, items }. A lab that was skipped or
 * unavailable keeps its findings outstanding.
 * @returns {Map<string, { lab, row, round, items }>}
 */
export function outstanding(db, top, rounds, head) {
  const known = new Map();
  const isAncestor = (a, b) => {
    if (a === b) return true;
    const key = `${a}\0${b}`;
    if (!known.has(key)) {
      try {
        git(top, ["merge-base", "--is-ancestor", a, b]);
        known.set(key, true);
      } catch {
        known.set(key, false);
      }
    }
    return known.get(key);
  };
  const roundOfSha = new Map(rounds.map((r) => [r.sha, r.round]));
  const rows = rounds.flatMap((r) => r.rows).sort((x, y) => (x.at === y.at ? x.id - y.id : x.at < y.at ? -1 : 1));
  const byLab = new Map();
  for (const row of rows) {
    if (row.verdict === "unavailable") continue;
    const prev = byLab.get(row.lab);
    if (!prev || isAncestor(prev.row.head_sha, row.head_sha)) byLab.set(row.lab, { lab: row.lab, row, round: roundOfSha.get(row.head_sha) });
  }
  const addressedAfter = (row) =>
    db
      .prepare("SELECT head_sha FROM cc_reviews WHERE cwd = ? AND lab = ? AND verdict = 'addressed' AND (at > ? OR (at = ? AND id > ?))")
      .all(top, META_LAB, row.at, row.at, row.id)
      .some((a) => isAncestor(row.head_sha, a.head_sha) && isAncestor(a.head_sha, head));
  const out = new Map();
  for (const [lab, entry] of byLab) {
    const items = openSerious(itemsOf(entry.row));
    if (items.length && !addressedAfter(entry.row)) out.set(lab, { ...entry, items });
  }
  return out;
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
 * each for HEAD; refuses a round past review.maxRounds unless forced. HEAD and the base are
 * resolved to shas once, and the diff is taken between those shas, so the commit the rows name
 * is the commit the labs read even if HEAD moves while they run. `--base` changes only the diff
 * the labs read: the rounds, the outstanding findings and the base recorded in each row always
 * come from the branch's own base (defaultBase), so a narrower diff cannot drop a finding
 * without the judge.
 * @returns {Promise<{ code: number, text: string }>}
 */
export async function runReview({ db, dbPath, cwd, env = process.env, config, labs = null, base = null, forceRound = false, sessionId = null, cli = "ledger", now = () => Date.now(), timeoutMs = REVIEW_TIMEOUT_MS }) {
  let top, head, branch, branchBase, baseSha, diff;
  try {
    ({ top, head } = gitHead(cwd));
    branch = currentBranch(top);
    branchBase = defaultBase(db, top, head, branch);
    baseSha = base ? commitOf(top, base) : branchBase;
    diff = git(top, ["diff", baseSha ?? EMPTY_TREE, head]);
  } catch (err) {
    return { code: 1, text: `refused ${err.message}; nothing reviewed` };
  }
  const range = `${baseSha ? short(baseSha) : "root"}..${short(head)}`;
  const list = labs ?? config.review?.labs ?? ["codex"];
  if (!list.length) return { code: 1, text: "refused review.labs is empty; nothing reviewed" };
  const max = config.review?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const rounds = branchRounds(db, top, branchBase, head);
  const round = roundOf(rounds, head);
  if (round > max && !forceRound) {
    return {
      code: 1,
      text: `stopped: this would be review round ${round} for this branch, and review.maxRounds is ${max}. Ask the human: waive with their reason (\`${cli} review waive "<why>"\`), or continue with \`${cli} review --force-round\`.`,
    };
  }
  // The newest pattern-check receipt in the repository, when one exists, goes in front of the
  // diff so the labs can hold the "how it fails" rows against the code (0.3.3).
  const receipt = newestReceipt(top, env);
  const input = receiptSection(receipt.text) + diff;
  const results = await Promise.allSettled(
    list.map(async (lab) => {
      if (!diff.trim()) return { verdict: "pass", findings: null, items: [], model: null, reason: `empty diff ${range}` };
      const adapter = ADAPTERS[lab];
      if (!adapter) throw new Error(`unknown lab ${lab}; supported: ${Object.keys(ADAPTERS).join(", ")}`);
      return adapter.run({ diff: input, timeoutMs, env, config: config.review ?? {} });
    }),
  );
  // Each lab's serious findings still open on this branch, this commit's earlier rows included:
  // a finding the new reply drops or downgrades goes to the judge, and a lab that is unavailable
  // or not run this time carries its findings onto this commit.
  const owed = outstanding(db, top, rounds, head);
  const carried = (entry, reason) => ({
    verdict: "findings",
    items: entry.items,
    findings: entry.items.map((it, k) => `${k + 1}. ${itemLine(it)} (from round ${entry.round})`).join("\n"),
    model: entry.row.model,
    reason,
  });
  const out = [`review of ${short(head)} (${range}) in ${top}, round ${round} of ${max}${round > max ? " (forced)" : ""}:`];
  let anyFindings = false;
  const record = (lab, r, judged = [], fromRound = null) => {
    insertRow(db, dbPath, { sessionId, cwd: top, head, base: branchBase ?? ROOT_BASE, branch, lab, model: r.model, verdict: r.verdict, findings: r.findings, items: r.items, reason: r.reason ?? null, at: nowIso(now()) });
    const model = r.model ? ` (${r.model})` : "";
    if (r.verdict === "findings") {
      anyFindings = true;
      out.push(`${lab}: findings${model}: ${countsText(severityCounts(r.items))}${r.carried ? ` · ${r.reason}` : ""}`, indent(r.findings));
    } else if (r.verdict === "pass-with-nits") out.push(`${lab}: pass with nits${model}: ${countsText(severityCounts(r.items))}`, indent(r.findings));
    else if (r.verdict === "unavailable") out.push(`${lab}: unavailable: ${r.reason}`);
    else out.push(`${lab}: pass${model}${r.reason ? ` · ${r.reason}` : ""}`);
    for (const it of judged) out.push(`  judge ${it.judge}: ${itemLine(it)} (round ${fromRound})`);
  };
  for (let i = 0; i < list.length; i++) {
    const lab = list[i];
    const res = results[i];
    let r = res.status === "fulfilled" ? res.value : { verdict: "unavailable", reason: res.reason?.message ?? String(res.reason), model: null, findings: null, items: [] };
    const before = owed.get(lab);
    if (r.verdict === "unavailable") {
      record(lab, before ? { ...carried(before, `unavailable (${r.reason}); its findings from round ${before.round} stay open`), carried: true } : r);
      continue;
    }
    const judged = [];
    const dropped = before ? before.items.filter((it) => !stillListed(it, r.items ?? [])) : [];
    if (dropped.length) {
      judged.push(...(await judgeItems({ db, dbPath, config, env, top, fromSha: before.row.head_sha, toSha: head, items: dropped })));
      const items = [...(r.items ?? []), ...judged];
      const stillOpen = judged.filter((it) => it.judge === "no");
      const findings = stillOpen.length ? [r.findings, ...stillOpen.map((it, k) => `${(r.items?.length ?? 0) + k + 1}. ${itemLine(it)} (from round ${before.round}; the judge says it is not resolved)`)].filter(Boolean).join("\n") : r.findings;
      r = { ...r, items, findings, verdict: verdictOf(items) };
    }
    record(lab, r, judged, before?.round);
  }
  for (const [lab, entry] of owed) {
    if (list.includes(lab)) continue;
    record(lab, { ...carried(entry, `not run this time; its findings from round ${entry.round} stay open`), carried: true });
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
  insertRow(db, dbPath, { sessionId, cwd: top, head, branch: currentBranch(top), lab: META_LAB, verdict: "waived", reason: why, at: nowIso(now) });
  return { code: 0, text: `waived the review gate for ${short(head)}: ${why}` };
}

/**
 * `review addressed "<why>"`: the manual override of findings, for HEAD; the reason is required.
 * The claim covers each lab's outstanding blocking and should findings on earlier commits of this
 * branch (see `outstanding`), and is refused when there are none, or when HEAD has review
 * findings of its own (those are fixed, committed and reviewed again, or waived). The judge
 * checks each finding against the change since its commit: any `no` records a findings row for
 * HEAD naming it (the gate stays closed) and refuses; otherwise an addressed row is recorded,
 * carrying the judged findings, `unverified` ones named.
 */
export async function addressed({ db, dbPath, cwd, reason, config = {}, env = process.env, sessionId = null, now = Date.now() }) {
  const why = String(reason ?? "").trim();
  if (!why) return { code: 1, text: 'refused review addressed needs the reason: review addressed "<why the findings no longer apply>"' };
  let top, head, branch;
  try {
    ({ top, head } = gitHead(cwd));
    branch = currentBranch(top);
  } catch (err) {
    return { code: 1, text: `refused ${err.message}` };
  }
  if (headState(db, top, head).findings.length) {
    return { code: 1, text: `refused ${short(head)} has review findings of its own; fix them, commit, and run \`review\` again, or waive with the human's reason` };
  }
  const base = defaultBase(db, top, head, branch);
  const owed = [...outstanding(db, top, branchRounds(db, top, base, head), head).values()].filter((e) => e.row.head_sha !== head);
  if (!owed.length) return { code: 1, text: `refused no outstanding review findings on an earlier commit of this branch in ${top}; nothing to address` };
  const judgedByLab = [];
  for (const entry of owed) {
    judgedByLab.push({ row: entry.row, items: await judgeItems({ db, dbPath, config, env, top, fromSha: entry.row.head_sha, toSha: head, items: entry.items }) });
  }
  const sources = [...new Set(owed.map((e) => short(e.row.head_sha)))].join(", ");
  const at = nowIso(now);
  const rejected = judgedByLab.filter(({ items }) => items.some((i) => i.judge === "no"));
  if (rejected.length) {
    const out = [`refused the judge says these findings on ${sources} are not resolved by ${short(head)}; the gate stays closed:`];
    for (const { row, items } of rejected) {
      const open = items.filter((i) => i.judge === "no");
      insertRow(db, dbPath, {
        sessionId,
        cwd: top,
        head,
        base: row.base_ref,
        branch,
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
  insertRow(db, dbPath, { sessionId, cwd: top, head, branch, lab: META_LAB, verdict: "addressed", items: all, reason: `${why} (findings on ${sources}${note})`, at });
  const out = [`recorded ${short(head)} as addressing the findings on ${sources}: ${why}`];
  for (const i of all) out.push(`  judge ${i.judge}: ${itemLine(i)}`);
  return { code: 0, text: out.join("\n") };
}

/**
 * The review state of `head` in repository `top` (see the table at the top of this file); `top`
 * null reads the rows for `head` from any repository folder (a pull request's head commit).
 */
export function headState(db, top, head) {
  const rows = top
    ? db.prepare("SELECT * FROM cc_reviews WHERE cwd = ? AND head_sha = ? ORDER BY at ASC, id ASC").all(top, head)
    : db.prepare("SELECT * FROM cc_reviews WHERE head_sha = ? ORDER BY at ASC, id ASC").all(head);
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

/**
 * The newest `.md` by mtime under the repository's pattern-check receipt directory
 * (`receiptDir` in `<top>/.pattern-check.json`, default `.pattern-check`): { text, path } or
 * { text: null }. Unreadable → { text: null }, one errors.log line; the review runs without it.
 */
export function newestReceipt(top, env = process.env) {
  let dir = ".pattern-check";
  try {
    const cfg = JSON.parse(readFileSync(join(top, ".pattern-check.json"), "utf8"));
    if (typeof cfg?.receiptDir === "string" && cfg.receiptDir.trim()) dir = cfg.receiptDir.trim();
  } catch {
    /* no config, or unreadable: the default directory */
  }
  const full = join(top, dir);
  let newest = null;
  try {
    for (const name of readdirSync(full)) {
      if (!name.endsWith(".md")) continue;
      const st = statSync(join(full, name));
      if (st.isFile() && (!newest || st.mtimeMs > newest.mtimeMs)) newest = { path: join(full, name), mtimeMs: st.mtimeMs };
    }
  } catch (err) {
    if (err.code !== "ENOENT") logError("review", `pattern-check receipt directory ${full} not readable: ${err.message}; reviewing without a receipt`, env);
    return { text: null };
  }
  if (!newest) return { text: null };
  try {
    return { text: readFileSync(newest.path, "utf8"), path: newest.path };
  } catch (err) {
    logError("review", `pattern-check receipt ${newest.path} not readable: ${err.message}; reviewing without a receipt`, env);
    return { text: null };
  }
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
  const rounds = branchRounds(db, top, defaultBase(db, top, head, currentBranch(top)), head);
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
    const { top, head } = gitHead(cwd, { timeoutMs: HOOK_GIT_TIMEOUT_MS });
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

/** Thrown when the gate cannot tell from a command which commit it publishes. */
export class UnknownTarget extends Error {}

// Options that take a separate value, per command, so positional arguments can be told apart.
const PUSH_OPTS_WITH_ARG = new Set(["--repo", "--receive-pack", "--exec", "-o", "--push-option"]);
const GH_MERGE_OPTS_WITH_ARG = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit"]);

/** The value of the first of `names` in `args` (`--x v` or `--x=v`); null when absent. */
function optValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1] ?? null;
      if (name.startsWith("--") && args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return null;
}

/** The positional arguments in `args`, skipping options and the values of those in `withArg`. */
function positionals(args, withArg) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") return [...out, ...args.slice(i + 1)];
    if (args[i].startsWith("-") && args[i] !== "-") {
      if (withArg.has(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * The commits one publishing operation (lib/gate.mjs pushOperations) would publish, each
 * { top, sha, unbound? }, `top` null when the commit is looked up by sha in any repository folder.
 * Every operation runs in the directory its `cd`s select, from the hook's cwd:
 *   git push       in the repository its `-C` options select. A deletion (`:dst`, `--delete`)
 *                  publishes nothing. Each refspec's source is resolved there (`+` dropped,
 *                  `HEAD` = HEAD). With no refspec, git uses `remote.<remote>.push` when set
 *                  and then `push.default`: HEAD, unless either says more (a configured push
 *                  refspec, or `matching`).
 *   gh pr create   no `--head`: HEAD (gh pushes the current branch). `--head <branch>`: gh does
 *                  not push, so the pull request's head is the branch on the remote as it is
 *                  now: `git ls-remote` of the branch's upstream (`branch.<b>.remote` and
 *                  `.merge`), else `origin`'s `refs/heads/<branch>`, bounded by GH_TIMEOUT_MS.
 *                  A local remote-tracking ref is never trusted: it may be stale.
 *                  `--head <owner>:<branch>` is another repository.
 *   gh pr merge    `--match-head-commit <sha>` when it is a full sha, else the head commit
 *                  `gh pr view [<selector>] [--repo …]` reports, marked `unbound`: the merge
 *                  itself does not require that commit.
 * [] when the operation runs outside a repository (git and gh refuse that themselves). Throws
 * UnknownTarget when the command does not say: `--all`, `--mirror`, `--tags`, `--branches`, a
 * matching (`:`) or pattern refspec, a configured push refspec or `push.default matching`,
 * `--git-dir`/`--work-tree`, a `cd` or `-C` the gate cannot resolve, another owner's branch, a
 * remote that cannot be read in time or has no such branch, a ref that names no commit, gh failing.
 */
export function operationTargets(op, cwd, { env = process.env } = {}) {
  const opts = { timeoutMs: HOOK_GIT_TIMEOUT_MS };
  const local = (dir) => {
    try {
      return gitHead(dir, opts);
    } catch (err) {
      if (err instanceof NotARepository) return null;
      throw err;
    }
  };
  const resolveRef = (top, ref) => {
    try {
      return commitOf(top, ref, opts);
    } catch (err) {
      throw new UnknownTarget(err.message);
    }
  };
  if (op.unsupported) throw new UnknownTarget(`${op.unsupported} is not followed`);
  const here = (op.cds ?? []).reduce((dir, d) => resolvePath(dir, d), cwd);
  if (op.tool === "git") {
    const repo = local(op.dirs.reduce((dir, d) => resolvePath(dir, d), here));
    if (!repo) return [];
    if (op.args.includes("--delete") || op.args.includes("-d")) return [];
    const many = op.args.find((a) => ["--all", "--mirror", "--tags", "--branches"].includes(a));
    if (many) throw new UnknownTarget(`git push ${many} publishes more than one ref`);
    const [remoteArg, ...refspecs] = positionals(op.args, PUSH_OPTS_WITH_ARG);
    if (!refspecs.length) {
      const branch = currentBranch(repo.top, opts);
      const first = (key) => gitConfig(repo.top, key, opts)[0] ?? null;
      const remote = remoteArg ?? ((branch && first(`branch.${branch}.pushRemote`)) || first("remote.pushDefault") || (branch && first(`branch.${branch}.remote`)) || "origin");
      if (gitConfig(repo.top, `remote.${remote}.push`, opts).length) throw new UnknownTarget(`remote.${remote}.push is configured, so git push picks its own refs`);
      const mode = first("push.default") ?? "simple";
      if (mode === "matching") throw new UnknownTarget("push.default is matching, so git push publishes every matching branch");
      if (mode === "nothing") return [];
      return [{ top: repo.top, sha: repo.head }];
    }
    const out = [];
    for (const spec of refspecs) {
      const bare = spec.replace(/^\+/, "");
      if (bare === ":") throw new UnknownTarget(`refspec ${spec} pushes every matching branch`);
      const src = bare.split(":")[0];
      if (!src) continue;
      if (src.includes("*")) throw new UnknownTarget(`refspec ${spec} is a pattern`);
      out.push({ top: repo.top, sha: src === "HEAD" ? repo.head : resolveRef(repo.top, src) });
    }
    return out;
  }
  if (op.sub === "create") {
    const repo = local(here);
    if (!repo) return [];
    const head = optValue(op.args, ["-H", "--head"]);
    if (!head) return [{ top: repo.top, sha: repo.head }];
    if (head.includes(":")) throw new UnknownTarget(`gh pr create --head ${head} names another owner's branch, which is not in this repository`);
    const first = (key) => gitConfig(repo.top, key, opts)[0] ?? null;
    const remote = first(`branch.${head}.remote`) ?? "origin";
    const ref = first(`branch.${head}.merge`) ?? `refs/heads/${head}`;
    const r = lsRemote(repo.top, remote, ref, env);
    if (!r.sha) throw new UnknownTarget(`gh pr create --head ${head} opens the pull request from ${remote}'s ${ref}, and ${r.why}; a local remote-tracking ref may be stale, so it was not used`);
    return [{ top: repo.top, sha: r.sha }];
  }
  const match = optValue(op.args, ["--match-head-commit"]);
  if (match && /^[0-9a-f]{40}$/i.test(match)) return [{ top: null, sha: match.toLowerCase() }];
  const repoOpt = optValue(op.args, ["-R", "--repo"]);
  const [selector] = positionals(op.args, GH_MERGE_OPTS_WITH_ARG);
  const args = ["pr", "view", ...(selector ? [selector] : []), ...(repoOpt ? ["--repo", repoOpt] : []), "--json", "headRefOid", "--jq", ".headRefOid"];
  const r = spawnSync("gh", args, { cwd: here, env, encoding: "utf8", timeout: GH_TIMEOUT_MS, killSignal: "SIGKILL" });
  const sha = String(r.stdout ?? "").trim();
  if (r.error || r.status !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) {
    const why = r.error ? (r.error.code === "ETIMEDOUT" ? `timed out after ${GH_TIMEOUT_MS / 1000}s` : r.error.message) : String(r.stderr || "").trim().split("\n").at(-1) || `exit ${r.status}`;
    throw new UnknownTarget(`gh pr view did not name the pull request's head commit (${why})`);
  }
  return [{ top: null, sha: sha.toLowerCase(), unbound: true }];
}

/**
 * What the command text alone says the gate cannot check, before any commit is resolved; null
 * when every operation can be followed. Under `gate` the hook denies with `reason`; under
 * `advise` it is a notice.
 *   unfollowed  an operation runs where the gate cannot follow (pushOperations `unsupported`: a
 *               computed `cd` or `-C`, `--git-dir`, `--work-tree`, a `GIT_*` setting, a `-c`
 *               that steers the push), so the repository and commit cannot be named.
 *   chained     a `git push` or `gh pr create` follows a command that can move HEAD on the same
 *               command line (pushOperations `after`), so the commit it publishes does not
 *               exist yet. `gh pr merge` is left out: its commit is the remote's, not HEAD.
 * Each reason states the way out: the push re-issued as its own literal command.
 */
export function commandRefusal(ops, cli = "ledger") {
  const name = (op) => (op.tool === "git" ? "git push" : `gh pr ${op.sub}`);
  const lost = ops.find((op) => op.unsupported);
  if (lost) {
    return {
      kind: "unfollowed",
      reason: `ledger: review gate: the gate cannot follow where this \`${name(lost)}\` runs (${lost.unsupported}), so the commit it publishes cannot be checked for a review. Re-issue it as its own command with a literal folder: \`cd /absolute/path && git push <remote> <branch>\`, with no variable, \`$(…)\`, \`~\`, glob or \`cd -\` in the folder, and no \`--git-dir\`, \`--work-tree\`, \`GIT_*\` setting or \`-c\` push config.`,
    };
  }
  const chained = ops.find((op) => op.after && !(op.tool === "gh" && op.sub === "merge"));
  if (chained) {
    return {
      kind: "chained",
      reason: `ledger: review gate: \`${chained.after}\` runs before this \`${name(chained)}\` on the same command line and can move HEAD, so the commit that would be published is not the one the gate can check now. Run \`${chained.after}\` first, review the new HEAD (\`${cli} review\`), then run \`${name(chained)}\` as its own command.`,
    };
  }
  return null;
}

/**
 * The review gate's answer for a set of publishing operations under `mode`: the strictest of
 * gateDecision over every commit they publish ({ deny } before { notice } before {}), or, when a
 * commit cannot be told from the command, an allow with a notice saying so. An allowed merge
 * whose commit came from `gh pr view` adds a notice naming the commit checked and the flag that
 * binds the merge to it.
 */
export function reviewDecision(db, ops, cwd, mode, { cli = "ledger", env = process.env, targets = null } = {}) {
  if (!targets) {
    try {
      targets = ops.flatMap((op) => operationTargets(op, cwd, { env }));
    } catch (err) {
      if (err instanceof UnknownTarget) return { notice: `ledger: the review gate could not tell which commit this command publishes (${err.message}); allowed without a review check` };
      throw err;
    }
  }
  const seen = new Set();
  const decisions = [];
  for (const t of targets) {
    const key = `${t.top ?? ""}\0${t.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    decisions.push(gateDecision(headState(db, t.top, t.sha), mode, cli));
  }
  const deny = decisions.find((d) => d.deny);
  if (deny) return deny;
  const notices = decisions.filter((d) => d.notice).map((d) => d.notice);
  if (mode !== "off") {
    for (const t of targets.filter((x) => x.unbound)) {
      notices.push(`ledger: the review gate checked ${short(t.sha)}, the pull request's head as gh reports it now; the merge is not bound to it. Add \`--match-head-commit ${t.sha}\` so gh refuses the merge if the head moves first.`);
    }
  }
  return notices.length ? { notice: notices.join("\n") } : {};
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
      : { status: "warn", name: "judge", text: `${judge.malformed ? `malformed shared judge file ${judge.malformed}; ` : ""}no LEDGER_JUDGE_BIN, review.judgeCommand, shared judge file command or i-have-audhd enforcement.judgeCommand: addressed claims unverified`, detail: [] },
  );
  return labs;
}
