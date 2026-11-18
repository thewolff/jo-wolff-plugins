// branches.mjs — unlanded branches as owed work. A session that commits on a branch owes landing
// it; nothing else notices a branch that was built and never pushed.
//
// Detection (hooks/post-tool-use.mjs): after a Bash call whose command runs `git commit` (any
// simple command of the line, `cd` and `git -C` followed as pushOperations follows them), the
// branch checked out in that folder is recorded as one cc_owed row with `branch` set: body
// `land branch <branch> in <worktree>`, the head sha and whether it is pushed. Plugin hooks fire
// for tool calls inside subagents too, so a subagent's commit is recorded the same way. Nothing
// is recorded for a detached HEAD, a repository with no origin base to compare against, or a
// branch whose commits are all on the base already. A later commit on the same branch updates the
// open row instead of making a second one (unique index on git_dir + branch while open).
//
// Landed: `git cherry <base> <branch>` prints no `+` line, which survives rebase-merge (it
// compares patch ids, not shas). The base is origin's HEAD when set, else origin/main, else
// origin/master, read from the local remote-tracking refs only: no fetch, no network, so a branch
// landed upstream resolves after the next fetch. A landed item moves to `done` with the base as
// its ref. A branch deleted locally is checked by its last head sha while that object exists.
//
// Every git call has HOOK_GIT_TIMEOUT_MS; a refresh stops after REFRESH_BUDGET_MS and checks at
// most BRANCH_CHECK_MAX items, oldest check first. Git runs outside any transaction; the writes
// go in one transaction afterwards.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { transaction } from "./db.mjs";
import { simpleCommands, SCOPE_OPEN, SCOPE_CLOSE } from "./gate.mjs";
import { createOwed, moveOwed } from "./owed.mjs";
import { git, gitHead, currentBranch, HOOK_GIT_TIMEOUT_MS, NotARepository } from "./review.mjs";
import { nowIso } from "./time.mjs";

export const BRANCH_CHECK_MAX = 20;
export const REFRESH_BUDGET_MS = 2_000;
export const BRANCH_BY = "ledger-branches";
const OPTS = { timeoutMs: HOOK_GIT_TIMEOUT_MS };
const GIT_OPT_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const PREFIX_WORDS = new Set(["command", "env", "exec", "time", "nohup"]);
const dynamic = (d) => !d || d === "-" || /[$`~*?[\]{}]/.test(d);

/** Cheap pre-filter run before anything else: false means the command cannot commit. */
export function mayCommit(command) {
  return typeof command === "string" && /\bgit\b/.test(command) && /\bcommit\b/.test(command);
}

/**
 * The folders `command` runs `git commit` in, resolved from `cwd` through each `cd` (in its
 * shell scope) and `-C`. A commit whose folder is an expansion, `~`, a glob or `cd -`, or that
 * sets `--git-dir` / `--work-tree`, is left out: its repository cannot be named from the text.
 */
export function commitDirs(command, cwd) {
  if (!mayCommit(command)) return [];
  const out = [];
  let scope = { cds: [], unknown: false };
  const outer = [];
  for (const words of simpleCommands(command)) {
    if (words.length === 1 && words[0] === SCOPE_OPEN) {
      outer.push(scope);
      scope = { cds: [...scope.cds], unknown: scope.unknown };
      continue;
    }
    if (words.length === 1 && words[0] === SCOPE_CLOSE) {
      if (outer.length) scope = outer.pop();
      continue;
    }
    const tokens = [...words];
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || PREFIX_WORDS.has(tokens[0]))) tokens.shift();
    if (!tokens.length) continue;
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      const dir = tokens.slice(1).find((t) => !t.startsWith("-") || t === "-");
      if (dynamic(dir)) scope.unknown = true;
      else scope.cds.push(dir);
      continue;
    }
    if (tokens[0].split("/").pop() !== "git") continue;
    const dirs = [];
    let unknown = scope.unknown;
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const t = tokens[i];
      if (t === "-C") {
        const d = tokens[i + 1] ?? "";
        if (dynamic(d)) unknown = true;
        dirs.push(d);
      }
      if (/^--(git-dir|work-tree)(=|$)/.test(t)) unknown = true;
      i += GIT_OPT_WITH_ARG.has(t) ? 2 : 1;
    }
    if (tokens[i] !== "commit" || unknown) continue;
    let dir = cwd;
    for (const d of [...scope.cds, ...dirs]) dir = isAbsolute(d) ? d : resolve(dir, d);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/** The base ref `git cherry` compares against: origin's HEAD, else origin/main, else origin/master; null when none exists. */
export function baseRef(gitDir) {
  try {
    const head = git(gitDir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], OPTS).trim();
    if (head) return head;
  } catch {
    /* origin/HEAD unset: try the usual names */
  }
  for (const ref of ["origin/main", "origin/master"]) {
    try {
      git(gitDir, ["rev-parse", "--verify", "-q", `refs/remotes/${ref}`], OPTS);
      return ref;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** The `+` lines of `git cherry` output: commits on the branch whose patch is not on the base. */
export function unlandedCommits(cherryOutput) {
  return String(cherryOutput)
    .split("\n")
    .filter((l) => l.startsWith("+ "))
    .map((l) => l.slice(2).trim());
}

function resolveRef(gitDir, ref) {
  try {
    return git(gitDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], OPTS).trim() || null;
  } catch {
    return null;
  }
}

function isAncestor(gitDir, a, b) {
  try {
    git(gitDir, ["merge-base", "--is-ancestor", a, b], OPTS);
    return true;
  } catch {
    return false;
  }
}

/**
 * What git says about one branch now: { state: 'landed'|'unpushed'|'pushed'|'gone'|'nobase', head, base }.
 * `gone`: neither the branch nor its last known head can be read. Throws only on a git fault
 * other than a missing ref (git missing, a timeout).
 */
export function branchStatus({ gitDir, branch, headSha = null }) {
  if (!gitDir || !existsSync(gitDir)) return { state: "gone", head: headSha, base: null };
  const head = resolveRef(gitDir, `refs/heads/${branch}`) ?? (headSha ? resolveRef(gitDir, headSha) : null);
  if (!head) return { state: "gone", head: headSha, base: null };
  const base = baseRef(gitDir);
  if (!base) return { state: "nobase", head, base: null };
  const plus = unlandedCommits(git(gitDir, ["cherry", base, head], OPTS));
  if (!plus.length) return { state: "landed", head, base };
  const remote = resolveRef(gitDir, `refs/remotes/origin/${branch}`);
  return { state: remote && isAncestor(gitDir, head, remote) ? "pushed" : "unpushed", head, base };
}

/**
 * What a commit in `dir` left: { repo, gitDir, branch, status } for the branch checked out there,
 * or null (not a repository, detached HEAD). Git only; writes nothing.
 */
export function inspectCommit(dir) {
  let top;
  try {
    top = gitHead(dir, OPTS).top;
  } catch (err) {
    if (err instanceof NotARepository) return null;
    throw err;
  }
  const branch = currentBranch(top, OPTS);
  if (!branch) return null;
  const common = git(top, ["rev-parse", "--git-common-dir"], OPTS).trim();
  const gitDir = isAbsolute(common) ? common : resolve(top, common);
  return { repo: top, gitDir, branch, status: branchStatus({ gitDir, branch }) };
}

/** The open owed row for this branch, or null. */
function openBranchItem(db, gitDir, branch) {
  return db.prepare("SELECT * FROM cc_owed WHERE git_dir = ? AND branch = ? AND state IN ('owed','started','deferred')").get(gitDir, branch) ?? null;
}

/**
 * Record what `inspectCommit` found: a new owed item, or the open one updated with the new head.
 * Nothing when the branch has nothing unlanded (or no base to compare with). Call inside a
 * transaction. Returns { item, created } or null.
 */
export function recordBranch(db, seen, { cwd, sessionId = null, by = BRANCH_BY, iso, now = Date.now() }) {
  if (!seen || !["unpushed", "pushed"].includes(seen.status.state)) return null;
  const existing = openBranchItem(db, seen.gitDir, seen.branch);
  if (existing) {
    db.prepare("UPDATE cc_owed SET head_sha = ?, branch_state = ?, checked_at = ?, repo = ? WHERE id = ?").run(seen.status.head, seen.status.state, iso, seen.repo, existing.id);
    return { item: { ...existing, head_sha: seen.status.head, branch_state: seen.status.state }, created: false };
  }
  const item = createOwed(db, { cwd, body: `land branch ${seen.branch} in ${seen.repo}`, origin: "agent", sessionId, by, iso, now });
  db.prepare("UPDATE cc_owed SET repo = ?, git_dir = ?, branch = ?, head_sha = ?, branch_state = ?, checked_at = ? WHERE id = ?").run(seen.repo, seen.gitDir, seen.branch, seen.status.head, seen.status.state, iso, item.id);
  return { item: db.prepare("SELECT * FROM cc_owed WHERE id = ?").get(item.id), created: true };
}

/**
 * Re-check open branch items (all of them, or `ids` only), oldest check first, at most `max`,
 * within `budgetMs`. Landed ones move to `done` (ref: `landed on <base>`); the rest get their
 * state and head refreshed. Returns { done: [ids], checked, errors: [messages] }.
 */
export function refreshBranches(db, { dbPath = "", ids = null, now = Date.now(), max = BRANCH_CHECK_MAX, budgetMs = REFRESH_BUDGET_MS, clock = Date.now } = {}) {
  let rows = db.prepare("SELECT * FROM cc_owed WHERE branch IS NOT NULL AND state IN ('owed','started','deferred') ORDER BY coalesce(checked_at, '') ASC, made_at ASC").all();
  if (ids) rows = rows.filter((r) => ids.includes(r.id));
  rows = rows.slice(0, max);
  if (!rows.length) return { done: [], checked: 0, errors: [] };
  const started = clock();
  const results = [];
  const errors = [];
  for (const r of rows) {
    if (clock() - started > budgetMs) break;
    try {
      results.push({ row: r, status: branchStatus({ gitDir: r.git_dir, branch: r.branch, headSha: r.head_sha }) });
    } catch (err) {
      errors.push(`${r.branch} in ${r.repo}: ${err.message}`);
    }
  }
  const iso = nowIso(now);
  const done = [];
  if (results.length) {
    transaction(
      db,
      () => {
        for (const { row, status } of results) {
          if (status.state === "landed") {
            const m = moveOwed(db, row.id, "done", `landed on ${status.base}`, { by: BRANCH_BY, iso, sessionId: null });
            if (m.status === "ok") done.push(row.id);
            db.prepare("UPDATE cc_owed SET head_sha = ?, checked_at = ? WHERE id = ?").run(status.head, iso, row.id);
          } else {
            db.prepare("UPDATE cc_owed SET head_sha = ?, branch_state = ?, checked_at = ? WHERE id = ?").run(status.head, status.state, iso, row.id);
          }
        }
      },
      dbPath,
    );
  }
  return { done, checked: results.length, errors };
}
