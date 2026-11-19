// branches.mjs — unlanded branches as owed work. A session that commits on a branch owes landing
// it; nothing else notices a branch that was built and never pushed.
//
// Detection (hooks/post-tool-use.mjs): after a Bash call whose command runs `git commit` (any
// simple command of the line, `cd` and `git -C` followed as pushOperations follows them, plus a `pushd` stack that `popd` unwinds), the
// branches committed to in that folder are recorded, one cc_owed row each with `branch` set: body
// `land branch <branch> in <worktree>`, the head sha and whether it is pushed. Two sources name
// them. A `[<branch> <sha>]` line git printed, counted only in the repository whose sha it names,
// is proof the command committed. The worktree's HEAD reflog adds every `commit…` entry stamped
// since the command began, each on the branch HEAD was on then (named by the next `checkout:
// moving from <branch>` entry, else the branch checked out now), so a quiet commit (`-q`) is found
// even when the line switches away after it, and alongside a printed one. A reflog entry is weaker
// evidence: another session's commit seconds earlier in the same worktree looks the same, and the
// hook has no HEAD from before the command to tell them apart, so an item found only that way is
// created or updated but never taken over from another session. A failed commit writes no entry.
// Plugin hooks fire
// for tool calls inside subagents too, so a subagent's commit is recorded the same way. Nothing
// is recorded for a detached HEAD, a repository with no origin base to compare against, or a
// branch whose commits are all on the base already. A later commit on the same branch updates the
// open row instead of making a second one (unique index on git_dir + branch while open).
//
// Landed: `git cherry <base> <branch>` prints no `+` line, which survives rebase-merge (it
// compares patch ids, not shas), and, when base..branch holds a merge commit (which cherry leaves
// out), the branch's tree is identical to the base's. The base is origin's HEAD when set, else origin/main, else
// origin/master, read from the local remote-tracking refs only: no fetch, no network, so a branch
// landed upstream resolves after the next fetch. A landed item moves to `done` with the base as
// its ref. A branch deleted locally is checked by its last head sha while that object exists.
//
// Every git call has HOOK_GIT_TIMEOUT_MS; in a refresh it gets only what is left of
// REFRESH_BUDGET_MS, and at most BRANCH_CHECK_MAX items are checked, oldest check first. A
// non-zero git exit is an answer (no such ref); a fault (the repository missing or no longer a git
// directory, git missing, a timeout, the budget spent) keeps the item's last checked state and is
// reported for errors.log. A row whose check faulted still has its checked_at advanced, so rows
// that keep failing go to the back of the queue instead of starving the rest. Git runs outside any transaction; the writes
// go in one transaction afterwards.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { transaction } from "./db.mjs";
import { simpleCommands, SCOPE_OPEN, SCOPE_CLOSE } from "./gate.mjs";
import { createOwed, moveOwed, reopenOwed, takeOverOwed } from "./owed.mjs";
import { git, gitHead, currentBranch, HOOK_GIT_TIMEOUT_MS, NotARepository } from "./review.mjs";
import { nowIso } from "./time.mjs";

export const BRANCH_CHECK_MAX = 20;
export const REFRESH_BUDGET_MS = 2_000;
export const BRANCH_BY = "ledger-branches";
// HEAD reflog entries read per folder after a commit; one Bash line rarely makes more.
const REFLOG_SCAN = 50;
const OPTS = { timeoutMs: HOOK_GIT_TIMEOUT_MS };

/** The error a git call throws when the check's deadline has passed before it could start. */
export class DeadlineError extends Error {}

/**
 * Options for one git call under `deadline` (an epoch-ms instant, or null for none): the hook's
 * per-call limit, cut to what is left of the deadline. Throws DeadlineError when nothing is left.
 */
function within(deadline, clock = Date.now) {
  if (deadline == null) return OPTS;
  const left = deadline - clock();
  if (left <= 0) throw new DeadlineError("the branch check ran out of time");
  return { timeoutMs: Math.max(1, Math.min(HOOK_GIT_TIMEOUT_MS, Math.floor(left))) };
}

/**
 * Run git where a non-zero exit is an answer (`no such ref`, `not an ancestor`): returns the
 * stdout, or null on a non-zero exit. A fault (git missing, a timeout, the deadline) throws.
 */
function gitAnswer(cwd, args, opts) {
  try {
    return git(cwd, args, opts);
  } catch (err) {
    if (err.gitStatus !== undefined) return null;
    throw err;
  }
}
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
  let scope = { cds: [], unknown: false, stack: [] };
  const outer = [];
  for (const words of simpleCommands(command)) {
    if (words.length === 1 && words[0] === SCOPE_OPEN) {
      outer.push(scope);
      scope = { cds: [...scope.cds], unknown: scope.unknown, stack: [...scope.stack] };
      continue;
    }
    if (words.length === 1 && words[0] === SCOPE_CLOSE) {
      if (outer.length) scope = outer.pop();
      continue;
    }
    const tokens = [...words];
    while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || PREFIX_WORDS.has(tokens[0]))) tokens.shift();
    if (!tokens.length) continue;
    if (tokens[0] === "popd") {
      // A popd this line did not pushd, or one with arguments, leaves a folder the text cannot name.
      const prev = tokens.length === 1 ? scope.stack.pop() : undefined;
      if (prev) Object.assign(scope, prev);
      else scope.unknown = true;
      continue;
    }
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      if (tokens[0] === "pushd") scope.stack.push({ cds: [...scope.cds], unknown: scope.unknown });
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

/**
 * The base ref `git cherry` compares against: origin's HEAD, else origin/main, else
 * origin/master; null when none exists. A git fault throws.
 */
export function baseRef(gitDir, { deadline = null, clock = Date.now } = {}) {
  const head = gitAnswer(gitDir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], within(deadline, clock))?.trim();
  if (head) return head;
  for (const ref of ["origin/main", "origin/master"]) {
    if (gitAnswer(gitDir, ["rev-parse", "--verify", "-q", `refs/remotes/${ref}`], within(deadline, clock)) !== null) return ref;
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

/**
 * The `[<branch> <sha>]` lines `git commit` prints, in order: [{ branch, sha }] with `sha` as
 * printed (abbreviated). `[detached HEAD <sha>]` and `(root-commit)` are handled; a quiet commit
 * (`-q`) prints none.
 */
export function committedRefs(output) {
  const out = [];
  for (const m of String(output ?? "").matchAll(/^\[(.+?) ([0-9a-f]{7,40})\] /gm)) {
    const label = m[1].replace(/ \(root-commit\)$/, "");
    out.push({ branch: label.startsWith("detached HEAD") || /\s/.test(label) ? null : label, sha: m[2] });
  }
  return out;
}

/**
 * With no `+` line from `git cherry`: true when that proves the branch landed. `git cherry` leaves
 * merge commits out, so a branch with one in base..head (a conflict resolution, say) counts as
 * landed only when its tree is byte-identical to the base's: then nothing on it is missing there.
 */
function landedThroughMerges(gitDir, base, head, { deadline, clock }) {
  const merges = Number(git(gitDir, ["rev-list", "--count", "--merges", `${base}..${head}`], within(deadline, clock)).trim());
  if (!merges) return true;
  return gitAnswer(gitDir, ["diff", "--quiet", base, head, "--"], within(deadline, clock)) !== null;
}

function resolveRef(gitDir, ref, opts) {
  return gitAnswer(gitDir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], opts)?.trim() || null;
}

/** The error branchStatus throws when the repository itself cannot be found. */
export class RepositoryMissing extends Error {}

/**
 * What git says about one branch now: { state: 'landed'|'unpushed'|'pushed'|'gone'|'nobase', head, base }.
 * `gone`: the repository is there but neither the branch nor its last known head can be read. A
 * fault (the repository missing or not a git directory, git missing, a timeout, `deadline` passed) throws, so the caller
 * keeps the last checked state.
 */
export function branchStatus({ gitDir, branch, headSha = null }, { deadline = null, clock = Date.now } = {}) {
  if (!gitDir || !existsSync(gitDir)) throw new RepositoryMissing(`the repository ${gitDir ?? "(none)"} is not there`);
  // Git run in a folder that is not a git directory reads no ref (an answer, so `gone`) or walks up
  // into an enclosing repository; neither is a statement about this branch.
  if (!existsSync(join(gitDir, "HEAD")) || !existsSync(join(gitDir, "objects"))) throw new RepositoryMissing(`the repository ${gitDir} is no longer a git directory`);
  const head = resolveRef(gitDir, `refs/heads/${branch}`, within(deadline, clock)) ?? (headSha ? resolveRef(gitDir, headSha, within(deadline, clock)) : null);
  if (!head) return { state: "gone", head: headSha, base: null };
  const base = baseRef(gitDir, { deadline, clock });
  if (!base) return { state: "nobase", head, base: null };
  const plus = unlandedCommits(git(gitDir, ["cherry", base, head], within(deadline, clock)));
  if (!plus.length && landedThroughMerges(gitDir, base, head, { deadline, clock })) return { state: "landed", head, base };
  const remote = resolveRef(gitDir, `refs/remotes/origin/${branch}`, within(deadline, clock));
  const pushed = remote && gitAnswer(gitDir, ["merge-base", "--is-ancestor", head, remote], within(deadline, clock)) !== null;
  return { state: pushed ? "pushed" : "unpushed", head, base };
}

/**
 * The commits the HEAD reflog of the worktree at `top` shows stamped at or after `since` (epoch
 * ms), newest first, as [{ sha, branch }]: `branch` is the one HEAD was on when the commit was
 * made, named by the next `checkout: moving from <branch> to …` entry, else the branch checked out
 * now (null while detached, and those are left out). [] with no `since` or no reflog.
 */
export function reflogCommits(top, since) {
  if (since == null) return [];
  const out = gitAnswer(top, ["reflog", "show", "-n", String(REFLOG_SCAN), "--date=unix", "--format=%H%x09%gd%x09%gs", "HEAD", "--"], OPTS);
  if (!out) return [];
  let branch = currentBranch(top, OPTS);
  const found = [];
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40,64})\t[^\t]*@\{(\d+)\}\t(.*)$/.exec(line);
    if (!m) continue;
    if (Number(m[2]) * 1000 < since) break;
    const moved = /^checkout: moving from (\S+) to \S+$/.exec(m[3]);
    if (moved) branch = moved[1];
    else if (/^commit\b/.test(m[3]) && branch) found.push({ sha: m[1], branch });
  }
  return found;
}

/**
 * What a commit in `dir` left: one { repo, gitDir, branch, status, evidence } per branch it
 * committed to. `evidence: 'header'`: a `[<branch> <sha>]` line of the command's output (`output`)
 * whose sha exists in this repository and is on that branch. `evidence: 'reflog'`: a HEAD reflog
 * commit since `since` (reflogCommits) still on its branch, for a branch no header named. [] for
 * no repository. Git only; writes nothing.
 */
export function inspectCommit(dir, output = "", { since = null } = {}) {
  let top;
  try {
    top = gitHead(dir, OPTS).top;
  } catch (err) {
    if (err instanceof NotARepository) return [];
    throw err;
  }
  const common = git(top, ["rev-parse", "--git-common-dir"], OPTS).trim();
  const gitDir = isAbsolute(common) ? common : resolve(top, common);
  const onBranch = (sha, branch) => gitAnswer(gitDir, ["merge-base", "--is-ancestor", sha, `refs/heads/${branch}`], OPTS) !== null;
  const found = [];
  const named = (branch) => found.some((f) => f.branch === branch);
  for (const { branch, sha } of committedRefs(output)) {
    if (!branch || named(branch)) continue;
    const full = resolveRef(gitDir, sha, OPTS);
    if (full && onBranch(full, branch)) found.push({ branch, evidence: "header" });
  }
  for (const { sha, branch } of reflogCommits(top, since)) {
    if (!named(branch) && onBranch(sha, branch)) found.push({ branch, evidence: "reflog" });
  }
  return found.map(({ branch, evidence }) => ({ repo: top, gitDir, branch, status: branchStatus({ gitDir, branch }), evidence }));
}

/** The open owed row for this branch, or null. */
function openBranchItem(db, gitDir, branch) {
  return db.prepare("SELECT * FROM cc_owed WHERE git_dir = ? AND branch = ? AND state IN ('owed','started','deferred')").get(gitDir, branch) ?? null;
}

/**
 * Store a checked status on an open branch item. A new unpushed head on a started or deferred
 * item moves it back to `owed`: the pull request or the reason it was held covered the old head.
 * The commit hook and refresh both come through here. Returns whether it was reopened.
 */
function applyStatus(db, row, status, { by, iso, sessionId = null }) {
  db.prepare("UPDATE cc_owed SET head_sha = ?, branch_state = ?, checked_at = ? WHERE id = ?").run(status.head, status.state, iso, row.id);
  const reopen = row.head_sha !== status.head && status.state === "unpushed" && row.state !== "owed";
  return reopen && reopenOwed(db, row.id, `new commit ${String(status.head).slice(0, 8)} after it was ${row.state}`, { by, iso, sessionId });
}

/**
 * Record what `inspectCommit` found: a new owed item, or the open one updated with the new head.
 * A new unpushed head on a started or deferred item moves it back to `owed`, so the Stop rule
 * reminds again: the pull request or the reason it was held covered the old head. An item found
 * by a printed header is handed to this session; one found only in the reflog (`evidence:
 * 'reflog'`) is not, since that entry may be another session's commit. Nothing when the branch has
 * nothing unlanded (or no base to compare with), or when a dropped or done item for it holds this
 * same head. Call inside a transaction.
 * Returns { item, created, reopened } or null.
 */
export function recordBranch(db, seen, { cwd, sessionId = null, by = BRANCH_BY, iso, now = Date.now() }) {
  if (!seen || !["unpushed", "pushed"].includes(seen.status.state)) return null;
  const existing = openBranchItem(db, seen.gitDir, seen.branch);
  if (existing) {
    const proven = seen.evidence !== "reflog";
    db.prepare("UPDATE cc_owed SET repo = ? WHERE id = ?").run(seen.repo, existing.id);
    const reopened = applyStatus(db, existing, seen.status, { by, iso, sessionId: proven ? sessionId : null });
    // The session that committed last owes the landing: its Stop refreshes and reminds.
    if (proven) takeOverOwed(db, existing.id, `committed ${String(seen.status.head).slice(0, 8)} in this session`, { by, iso, sessionId });
    return { item: db.prepare("SELECT * FROM cc_owed WHERE id = ?").get(existing.id), created: false, reopened };
  }
  // A closed item at this very head means nothing was committed since it was dropped or done: a
  // reflog entry from just before the command, not new work.
  if (db.prepare("SELECT 1 FROM cc_owed WHERE git_dir = ? AND branch = ? AND head_sha = ? AND state IN ('dropped','done')").get(seen.gitDir, seen.branch, seen.status.head)) return null;
  const item = createOwed(db, { cwd, body: `land branch ${seen.branch} in ${seen.repo}`, origin: "agent", sessionId, by, iso, now });
  db.prepare("UPDATE cc_owed SET repo = ?, git_dir = ?, branch = ?, head_sha = ?, branch_state = ?, checked_at = ? WHERE id = ?").run(seen.repo, seen.gitDir, seen.branch, seen.status.head, seen.status.state, iso, item.id);
  return { item: db.prepare("SELECT * FROM cc_owed WHERE id = ?").get(item.id), created: true, reopened: false };
}

/**
 * Re-check open branch items (all of them, or `ids` only), oldest check first, at most `max`,
 * within `budgetMs`: every git call gets only what is left of it. Landed ones move to `done`
 * (ref: `landed on <base>`); the rest get their state and head refreshed. A fault on one branch
 * (git missing, a timeout, the budget spent) leaves its last checked state and is returned in
 * `errors`; a branch whose own check faulted gets only checked_at advanced, so the next refresh
 * starts with the rows not tried. Returns { done: [ids], checked, errors: [messages] }.
 */
export function refreshBranches(db, { dbPath = "", ids = null, now = Date.now(), max = BRANCH_CHECK_MAX, budgetMs = REFRESH_BUDGET_MS, clock = Date.now } = {}) {
  let rows = db.prepare("SELECT * FROM cc_owed WHERE branch IS NOT NULL AND state IN ('owed','started','deferred') ORDER BY coalesce(checked_at, '') ASC, made_at ASC").all();
  if (ids) rows = rows.filter((r) => ids.includes(r.id));
  rows = rows.slice(0, max);
  if (!rows.length) return { done: [], checked: 0, errors: [] };
  const deadline = clock() + budgetMs;
  const results = [];
  const failed = [];
  const errors = [];
  for (const r of rows) {
    if (clock() >= deadline) {
      errors.push(`${rows.length - results.length - errors.length} branch(es) not checked: the ${budgetMs} ms budget was spent`);
      break;
    }
    try {
      results.push({ row: r, status: branchStatus({ gitDir: r.git_dir, branch: r.branch, headSha: r.head_sha }, { deadline, clock }) });
    } catch (err) {
      failed.push(r.id);
      errors.push(`${r.branch} in ${r.repo}: ${err.message}; kept as last checked`);
    }
  }
  const iso = nowIso(now);
  const done = [];
  if (results.length || failed.length) {
    transaction(
      db,
      () => {
        for (const id of failed) db.prepare("UPDATE cc_owed SET checked_at = ? WHERE id = ?").run(iso, id);
        for (const { row, status } of results) {
          // Compare-and-set: a commit recorded while git ran outside this transaction wins.
          const current = db.prepare("SELECT head_sha, state FROM cc_owed WHERE id = ?").get(row.id);
          if (!current || current.head_sha !== row.head_sha || current.state !== row.state) continue;
          if (status.state === "landed") {
            const m = moveOwed(db, row.id, "done", `landed on ${status.base}`, { by: BRANCH_BY, iso, sessionId: null });
            if (m.status === "ok") done.push(row.id);
            db.prepare("UPDATE cc_owed SET head_sha = ?, checked_at = ? WHERE id = ?").run(status.head, iso, row.id);
          } else {
            applyStatus(db, row, status, { by: BRANCH_BY, iso });
          }
        }
      },
      dbPath,
    );
  }
  return { done, checked: results.length, errors };
}
