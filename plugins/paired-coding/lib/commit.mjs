// commit.mjs — the commit pair_done makes when the agreed card asked for one.
//
// WHY THE GATE COMMITS
//   pair_run cannot commit in a linked worktree (git's directory lies outside the worktree), on
//   Linux (all of .git is read-only), or anywhere the boundary does not cover .git/. The card
//   carries the commit request, so the partner's agreement covers it, and the gate runs git here,
//   on the host side, outside the sandbox.
//
// WHAT IT COMMITS
//   Only the paths pair_done found changed inside the boundary, through `git commit --only`, so
//   whatever the person staged themselves is neither committed nor unstaged. Every pathspec is
//   literal (--literal-pathspecs) and passed NUL-separated on stdin, never on a command line and
//   never through a shell; the message goes in a temporary file read with -F. Repository hooks
//   run as they would for the person.
//
// WHAT IT REFUSES
//   A merge, rebase, cherry-pick, revert or bisect in progress, a detached HEAD, and a change set
//   that changed the hooks directory git would run (core.hooksPath inside the worktree): those
//   hooks would run outside the sandbox before the person read them.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Each plumbing call's limit, and the commit's (hooks run inside it). */
const GIT_TIMEOUT_MS = 60 * 1000;
const COMMIT_TIMEOUT_MS = 100 * 1000;

/** What git leaves in its directory while an operation is in progress, and what it is called. */
export const IN_PROGRESS = Object.freeze([
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or am"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["sequencer", "a cherry-pick or revert sequence"],
  ["BISECT_LOG", "a bisect"],
]);

/**
 * Variables that would point git at another repository, index or object store, or add config
 * on the command line. The commit runs against the worktree pair_start recorded, so none of
 * them may steer it. Identity and the global config file stay the host's own.
 */
const REPO_STEERING = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXEC_PATH|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/;

/**
 * The environment git runs with: the adapter's own (the host's identity and git config, never
 * pair_run's), less every variable that steers git elsewhere, with no terminal prompt.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function commitEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === "string" && !REPO_STEERING.test(k)) out[k] = v;
  }
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

function git(root, env, args, opts = {}) {
  // Every pathspec literal, so a file named `src/*` or `:(top)` is that file and nothing more.
  // check-ignore takes plain paths, not pathspecs, and refuses the flag.
  const literal = opts.literal === false ? [] : ["--literal-pathspecs"];
  const res = spawnSync("git", [...literal, ...args], {
    cwd: root,
    env,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const error = res.error ? (res.error.code === "ETIMEDOUT" ? `timed out after ${(opts.timeoutMs ?? GIT_TIMEOUT_MS) / 1000}s` : res.error.message) : null;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error };
}

const nul = (paths) => paths.map((p) => `${p}\0`).join("");
const splitNul = (text) => text.split("\0").filter((s) => s !== "");

/** Up to five paths, then how many more: a dependency install can change thousands. */
export function someOf(paths) {
  return paths.length <= 5 ? paths.join(", ") : `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more`;
}
const gitFailure = (what, r) => `${what} failed: ${r.error ?? (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`)}`;

/**
 * Commit the changed boundary paths of a change set.
 * @param {{ root: string, paths: string[], message: string, env?: Record<string, string | undefined> }} args
 *   `root`: the worktree, canonical. `paths`: worktree-relative, every one inside the agreed
 *   boundary (pair_done's `changed`)
 * @returns {{ ok: true, sha: string, subject: string, paths: string[], skipped: string[] }
 *   | { ok: false, refused?: true, reason: string }}
 *   `skipped`: changed paths git ignores (an untracked path under .gitignore) or never tracked
 *   and now gone, which the commit leaves out
 */
export function commitBoundary({ root, paths, message, env }) {
  const genv = commitEnv(env ?? process.env);
  const top = git(root, genv, ["rev-parse", "--absolute-git-dir"]);
  if (top.status !== 0) return { ok: false, reason: gitFailure("git rev-parse --absolute-git-dir", top) };
  const gitDir = top.stdout.trim();
  for (const [name, what] of IN_PROGRESS) {
    if (existsSync(join(gitDir, name))) return { ok: false, refused: true, reason: `${what} is in progress in this worktree (${name} is in ${gitDir}); the gate does not commit during one` };
  }
  const head = git(root, genv, ["symbolic-ref", "-q", "HEAD"]);
  if (head.status === 1) return { ok: false, refused: true, reason: "HEAD is detached; the gate commits only onto a branch" };
  if (head.status !== 0) return { ok: false, reason: gitFailure("git symbolic-ref HEAD", head) };

  const hooks = git(root, genv, ["rev-parse", "--git-path", "hooks"]);
  if (hooks.status !== 0) return { ok: false, reason: gitFailure("git rev-parse --git-path hooks", hooks) };
  const hooksRel = hooksInWorktree(root, hooks.stdout.trim());
  if (hooksRel !== null) {
    const touched = paths.filter((p) => hooksRel === "" || p === hooksRel || p.startsWith(`${hooksRel}/`));
    if (touched.length) return { ok: false, refused: true, reason: `the change set changed ${someOf(touched)} in the hooks directory git runs (${hooksRel || "."}); the gate does not run hooks your partner has not read back, so commit by hand after the read-back` };
  }
  // Paths relative to the worktree root, as pair_done's are, and only under it.
  const tracked = git(root, genv, ["ls-files", "-z", "--cached"]);
  if (tracked.status !== 0) return { ok: false, reason: gitFailure("git ls-files", tracked) };
  const isTracked = new Set(splitNul(tracked.stdout));
  // A directory's own entry (a mode change pair_done reports) is never a pathspec: as one it
  // would take in every file beneath it, agreed or not.
  const kind = (p) => { try { return lstatSync(join(root, p)).isDirectory() ? "dir" : "file"; } catch { return "absent"; } };
  const kinds = new Map(paths.map((p) => [p, kind(p)]));
  const untracked = paths.filter((p) => !isTracked.has(p) && kinds.get(p) === "file");
  let ignored = new Set();
  if (untracked.length) {
    const ig = git(root, genv, ["check-ignore", "-z", "--stdin"], { input: nul(untracked), literal: false });
    if (ig.status !== 0 && ig.status !== 1) return { ok: false, reason: gitFailure("git check-ignore", ig) };
    ignored = new Set(splitNul(ig.stdout));
  }
  const freshSet = new Set(untracked.filter((p) => !ignored.has(p)));
  const fresh = [...freshSet];
  const commitPaths = paths.filter((p) => kinds.get(p) !== "dir" && (isTracked.has(p) || freshSet.has(p)));
  const committing = new Set(commitPaths);
  const skipped = paths.filter((p) => !committing.has(p));
  if (commitPaths.length === 0) return { ok: false, refused: true, reason: `no changed path is one git tracks or would add (skipped: ${someOf(skipped)})` };

  // A new file has to be known to the index before `commit --only` takes it; intent-to-add
  // records only that, and is taken back if the commit does not happen.
  if (fresh.length) {
    const add = git(root, genv, ["add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: nul(fresh) });
    if (add.status !== 0) return { ok: false, reason: gitFailure("git add --intent-to-add", add) };
  }
  const tmp = mkdtempSync(join(tmpdir(), "paired-coding-commit-"));
  try {
    const msgFile = join(tmp, "message");
    writeFileSync(msgFile, message.endsWith("\n") ? message : `${message}\n`, { mode: 0o600 });
    const c = git(root, genv, ["commit", "--only", "-F", msgFile, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: nul(commitPaths), timeoutMs: COMMIT_TIMEOUT_MS });
    if (c.status !== 0) {
      const undo = fresh.length ? git(root, genv, ["rm", "--cached", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: nul(fresh) }) : null;
      const left = undo && undo.status !== 0 ? `; the intent-to-add entries for ${fresh.join(", ")} stay in the index (${gitFailure("git rm --cached", undo)})` : "";
      return { ok: false, reason: `${gitFailure("git commit", c)}${left}` };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const log = git(root, genv, ["log", "-1", "--format=%H%x00%s"]);
  if (log.status !== 0) return { ok: false, reason: `the commit was made but reading it back ${gitFailure("git log", log)}` };
  const [sha, subject] = log.stdout.replace(/\n$/, "").split("\0");
  return { ok: true, sha, subject, paths: commitPaths, skipped };
}

/**
 * The hooks directory git runs, worktree-relative ("" for the root itself), when it lies inside
 * the worktree; null when it lies outside (the usual `.git/hooks`, which pair_run cannot write).
 */
function hooksInWorktree(root, hooksPath) {
  const abs = isAbsolute(hooksPath) ? hooksPath : join(root, hooksPath);
  let real = abs;
  try { real = realpathSync.native(abs); } catch { /* absent: judged by its spelling */ }
  if (real === root) return "";
  return real.startsWith(`${root}/`) ? real.slice(root.length + 1) : null;
}
