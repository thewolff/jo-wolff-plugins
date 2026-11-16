// commit.mjs — the commit pair_done makes when the agreed card asked for one.
//
// WHY THE GATE COMMITS
//   pair_run cannot commit in a linked worktree (git's directory lies outside the worktree), on
//   Linux (all of .git is read-only), or anywhere the boundary does not cover .git/. The card
//   carries the commit request, so the partner's agreement covers it, and the gate runs git here,
//   on the host side, outside the sandbox.
//
// WHAT IT COMMITS
//   The bytes pair_done's read-back showed, never the worktree as it is now: the adapter copies
//   each changed boundary file into the session directory right after the snapshot, checks the
//   copy against the snapshot's hash, and hands the copies here. The commit is built with
//   plumbing in a temporary index: read-tree HEAD, hash-object --no-filters for each copy,
//   update-index, write-tree, commit-tree, then update-ref HEAD <new> <old>, which fails if HEAD
//   moved meanwhile. Nothing the person staged is committed, since the temporary index starts
//   from HEAD; afterwards the person's own index takes the new blobs only for paths whose entry
//   still equalled the old HEAD, so a version they staged themselves stays staged.
//
// WHAT IT NEVER RUNS
//   No code from the repository: no hooks (core.hooksPath=/dev/null, and commit-tree runs none),
//   no clean or smudge filters (--no-filters; nothing checks a file out), no fsmonitor, no
//   signing program. Agent-written bytes inside the boundary are not run outside the sandbox
//   before the read-back. A config file inside the worktree (a tracked file pulled in by
//   include.path) refuses the commit, since git would read it on every call.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Each git call's limit. */
const GIT_TIMEOUT_MS = 60 * 1000;

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
 * Variables dropped from git's environment: the ones that point git at another repository,
 * index, object store or config, or add config on the command line, and the ones that name a
 * program for git to run (editor, pager, ssh, askpass, external diff, gpg). Identity and the
 * global config file stay the host's own.
 */
const DROPPED = /^(GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXEC_PATH|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS|EDITOR|SEQUENCE_EDITOR|PAGER|SSH|SSH_COMMAND|SSH_VARIANT|ASKPASS|EXTERNAL_DIFF|DIFF_OPTS|TRACE\w*|PROXY_COMMAND)|SSH_ASKPASS|GPG_\w+|GNUPGHOME|EDITOR|VISUAL|PAGER)$/;

/**
 * The environment git runs with: the adapter's own (the host's identity and git config, never
 * pair_run's), less DROPPED, with no terminal prompt.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function commitEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === "string" && !DROPPED.test(k)) out[k] = v;
  }
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

/** Ahead of every subcommand: pathspecs literal, and nothing of the repository's to run. */
const SAFE = ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

function git(root, env, args, opts = {}) {
  const res = spawnSync("git", [...SAFE, ...args], {
    cwd: root,
    env: opts.index ? { ...env, GIT_INDEX_FILE: opts.index } : env,
    input: opts.input,
    encoding: opts.binary ? "buffer" : "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  const error = res.error ? (res.error.code === "ETIMEDOUT" ? `timed out after ${GIT_TIMEOUT_MS / 1000}s` : res.error.message) : null;
  const text = (b) => (b == null ? "" : typeof b === "string" ? b : b.toString("utf8"));
  return { status: res.status, stdout: text(res.stdout), stderr: text(res.stderr), error };
}

const nul = (paths) => paths.map((p) => `${p}\0`).join("");
const splitNul = (text) => text.split("\0").filter((s) => s !== "");
const gitFailure = (what, r) => `${what} failed: ${r.error ?? (r.stderr.trim() || r.stdout.trim() || `exit ${r.status}`)}`;

/** Up to five paths, then how many more: a dependency install can change thousands. */
export function someOf(paths) {
  return paths.length <= 5 ? paths.join(", ") : `${paths.slice(0, 5).join(", ")} and ${paths.length - 5} more`;
}

/**
 * `ls-files -s -z` output as path → "<mode> <sha>", stage 0 only (a conflicted path has no
 * stage-0 entry, so it never equals HEAD and the person's index keeps it).
 */
function stagedEntries(text) {
  const out = new Map();
  for (const rec of splitNul(text)) {
    const tab = rec.indexOf("\t");
    const [mode, sha, stage] = rec.slice(0, tab).split(" ");
    if (stage === "0") out.set(rec.slice(tab + 1), `${mode} ${sha}`);
  }
  return out;
}

const inside = (root, p) => p === root || p.startsWith(`${root}/`);
const real = (p) => { try { return realpathSync.native(p); } catch { return p; } };

/**
 * Commit a change set's read-back bytes onto the worktree's branch.
 * @param {{ root: string, entries: Array<{ path: string, kind: "file" | "link" | "absent", source?: string, exec?: boolean, target?: string }>, message: string, env?: Record<string, string | undefined> }} args
 *   `root`: the worktree, canonical. `entries`: the changed boundary paths, each a file (its
 *   read-back copy in `source`, `exec` from the snapshot's mode), a symlink (`target`), or gone
 * @returns {{ ok: true, sha: string, subject: string, paths: string[], skipped: string[], keptStaged: string[], indexNote?: string }
 *   | { ok: false, refused?: true, reason: string }}
 */
export function commitBoundary({ root, entries, message, env }) {
  const genv = commitEnv(env ?? process.env);
  const dirs = git(root, genv, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--show-object-format"]);
  if (dirs.status !== 0) return { ok: false, reason: gitFailure("git rev-parse --absolute-git-dir", dirs) };
  const [gitDir, commonDir, objectFormat] = dirs.stdout.trim().split("\n");
  // A removal in --index-info is mode 0 with the null object id, sized for the repository.
  const nullId = "0".repeat(objectFormat === "sha256" ? 64 : 40);
  for (const [name, what] of IN_PROGRESS) {
    if (existsSync(join(gitDir, name))) return { ok: false, refused: true, reason: `${what} is in progress in this worktree (${name} is in ${gitDir}); the gate does not commit during one` };
  }
  const head = git(root, genv, ["symbolic-ref", "-q", "HEAD"]);
  if (head.status === 1) return { ok: false, refused: true, reason: "HEAD is detached; the gate commits only onto a branch" };
  if (head.status !== 0) return { ok: false, reason: gitFailure("git symbolic-ref HEAD", head) };
  const branch = head.stdout.trim();

  // Config git reads on every call. One inside the worktree, outside git's own directory (which
  // pair_run cannot write), is a file the agent could have written.
  const cfg = git(root, genv, ["config", "--show-origin", "--list", "-z"]);
  if (cfg.status !== 0) return { ok: false, reason: gitFailure("git config --list", cfg) };
  const fenced = [real(gitDir), real(commonDir)];
  const rootReal = real(root);
  const tokens = cfg.stdout.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    if (!tokens[i].startsWith("file:")) continue;
    const file = tokens[i].slice(5);
    const abs = real(isAbsolute(file) ? file : join(root, file));
    if (inside(rootReal, abs) && !fenced.some((d) => inside(d, abs))) {
      return { ok: false, refused: true, reason: `git reads config from ${abs.slice(rootReal.length + 1)}, a file inside the worktree (included from your git config); the gate does not commit while a file the agent could write configures git` };
    }
  }

  const old = git(root, genv, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  const oldSha = old.status === 0 ? old.stdout.trim() : null;
  const tmp = mkdtempSync(join(tmpdir(), "paired-coding-commit-"));
  try {
    const index = join(tmp, "index");
    // Everything that reads or writes an index runs against an empty work tree. Writing an index
    // makes git re-check "racily clean" entries against their files, through the clean filters
    // .gitattributes selects; with nothing in the work tree it finds no file, reads no
    // attributes, runs no filter, and only marks such an entry for the next `git status` to
    // refresh.
    const empty = join(tmp, "empty-worktree");
    mkdirSync(empty);
    const penv = { ...genv, GIT_DIR: gitDir, GIT_WORK_TREE: empty };
    const plumb = (args, opts = {}) => git(empty, penv, args, opts);
    const rt = plumb(oldSha ? ["read-tree", oldSha] : ["read-tree", "--empty"], { index });
    if (rt.status !== 0) return { ok: false, reason: gitFailure("git read-tree", rt) };
    const headLs = plumb(["ls-files", "-s", "-z"], { index });
    if (headLs.status !== 0) return { ok: false, reason: gitFailure("git ls-files (HEAD)", headLs) };
    const inHead = stagedEntries(headLs.stdout);
    const realLs = plumb(["ls-files", "-s", "-z"]);
    if (realLs.status !== 0) return { ok: false, reason: gitFailure("git ls-files", realLs) };
    const inIndex = stagedEntries(realLs.stdout);
    const known = (p) => inHead.has(p) || inIndex.has(p);

    // A path neither HEAD nor the index knows is added unless git ignores it (.gitignore and
    // the exclude files are read, never run).
    const fresh = entries.filter((e) => e.kind !== "absent" && !known(e.path)).map((e) => e.path);
    let ignored = new Set();
    if (fresh.length) {
      const ig = spawnSync("git", ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"], { cwd: root, env: genv, input: nul(fresh), encoding: "utf8", timeout: GIT_TIMEOUT_MS });
      if (ig.status !== 0 && ig.status !== 1) return { ok: false, reason: gitFailure("git check-ignore", { ...ig, error: ig.error?.message ?? null }) };
      ignored = new Set(splitNul(ig.stdout ?? ""));
    }

    const records = [];
    const paths = [];
    const skipped = [];
    for (const e of entries) {
      if (e.kind === "absent") {
        if (!inHead.has(e.path)) { skipped.push(e.path); continue; }
        records.push({ path: e.path, entry: null });
        paths.push(e.path);
        continue;
      }
      if (ignored.has(e.path)) { skipped.push(e.path); continue; }
      const bytes = e.kind === "link" ? Buffer.from(e.target ?? "", "utf8") : readFileSync(e.source);
      const h = plumb(["hash-object", "-w", "--no-filters", "--stdin"], { input: bytes });
      if (h.status !== 0) return { ok: false, reason: gitFailure(`git hash-object (${e.path})`, h) };
      const mode = e.kind === "link" ? "120000" : e.exec ? "100755" : "100644";
      records.push({ path: e.path, entry: `${mode} ${h.stdout.trim()}` });
      paths.push(e.path);
    }
    if (records.length === 0) return { ok: false, refused: true, reason: `no changed path is one git tracks or would add (skipped: ${someOf(skipped)})` };

    const indexInfo = (recs) => recs.map((r) => `${r.entry ?? `0 ${nullId}`}\t${r.path}\0`).join("");
    const ui = plumb(["update-index", "-z", "--index-info"], { index, input: indexInfo(records) });
    if (ui.status !== 0) return { ok: false, reason: gitFailure("git update-index", ui) };
    const wt = plumb(["write-tree"], { index });
    if (wt.status !== 0) return { ok: false, reason: gitFailure("git write-tree", wt) };
    const tree = wt.stdout.trim();
    if (oldSha) {
      const oldTree = plumb(["rev-parse", `${oldSha}^{tree}`]);
      if (oldTree.status === 0 && oldTree.stdout.trim() === tree) return { ok: false, refused: true, reason: "the read-back bytes already equal HEAD, so there is nothing to commit" };
    }
    const msgFile = join(tmp, "message");
    writeFileSync(msgFile, message.endsWith("\n") ? message : `${message}\n`, { mode: 0o600 });
    const ct = plumb(["commit-tree", "--no-gpg-sign", tree, ...(oldSha ? ["-p", oldSha] : []), "-F", msgFile]);
    if (ct.status !== 0) return { ok: false, reason: gitFailure("git commit-tree", ct) };
    const sha = ct.stdout.trim();
    const subject = message.split("\n")[0];
    // Compare-and-swap: refused if the branch moved since read-tree.
    const ur = plumb(["update-ref", "-m", `pair_done: ${subject}`, "HEAD", sha, oldSha ?? ""]);
    if (ur.status !== 0) return { ok: false, reason: `${gitFailure("git update-ref", ur)} (${branch} moved while the commit was built; nothing was committed)` };

    // The person's index: a committed path takes the new entry only where it still equalled the
    // old HEAD (absent in both counts), so `git status` shows it clean; anything they staged
    // themselves stays staged.
    const keptStaged = [];
    const follow = [];
    for (const r of records) {
      if ((inIndex.get(r.path) ?? null) === (inHead.get(r.path) ?? null)) follow.push(r);
      else keptStaged.push(r.path);
    }
    let indexNote;
    if (follow.length) {
      const ri = plumb(["update-index", "-z", "--index-info"], { input: indexInfo(follow) });
      if (ri.status !== 0) indexNote = `the commit was made, but updating your index failed, so git status may show ${someOf(follow.map((r) => r.path))} as changed against it: ${gitFailure("git update-index", ri)}`;
    }
    return { ok: true, sha, subject, paths, skipped, keptStaged, ...(indexNote ? { indexNote } : {}) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
