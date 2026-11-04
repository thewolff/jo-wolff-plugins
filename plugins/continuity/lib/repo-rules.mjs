// lib/repo-rules.mjs — the rules files that scope a working directory, re-inlined after a
// compaction, and the durable-notes probe that sits under them in the same restore block.
//
// The host re-reads the rules files above its launch directory on its own; the ones below it
// (a nested `CLAUDE.md` the host loaded when the session read into that subtree, or the rules
// of a repository the session `cd`'d into) were in the conversation, and the compaction took
// them with it. `walkRules(cwd)` collects, per directory from the cwd up to the walk root,
// `CLAUDE.md` (with `CLAUDE.local.md` after it) else `AGENTS.md`, and `renderRules()` inlines
// them root-first, nearest last, so the nearest file's rules are read last and win.
//
// The walk root, in this order:
//   1. The git root: the nearest directory at or above the cwd holding a `.git` entry (a
//      directory, or the file a worktree keeps). The cwd is resolved through its symlinks first,
//      so the ancestry walked is the real one.
//   2. Above the git root, the nearest directory holding a rules file (a workspace that keeps
//      one rules file over several checkouts), searched up to but not including the home
//      directory and the filesystem root. When one is found it is the root; nothing above it is
//      read, and the directories between it and the git root hold no rules file by construction.
//   3. With no git root at all, the cwd alone: one directory, no search above it.
//
// Caps (bytes, so the count is the one a reader sees in `wc -c`): RULES_FILE_MAX_BYTES per file
// and RULES_TOTAL_MAX_BYTES for the section, the per-file cap the one the source hook applied
// to each rules file and the total the one its sibling hook used for injecting one rules chain
// live. The caller passes what remains of the restore's own character guard (lib/snapshot.mjs
// RESTORE_MAX_CHARS) after the snapshot body, so the section can never push the restore past it;
// the rules are what gives way first. Within the total, the smallest files land whole and the
// largest are cut, each cut announced in-band (`(truncated at N bytes …)`); a file that would get
// less than RULES_MIN_BYTES is skipped and named instead of inlined as a stub.
//
// Safety: nothing here spawns a process, nothing throws, and a rules file that is a symlink to a
// path outside the walk root is skipped and named. A file already included under another path
// (two levels symlinked to one file) is skipped and named. A level that is an ancestor of, or
// is, `CLAUDE_PROJECT_DIR` when the host set it is skipped and named: the host loaded that file
// at launch and keeps it; re-inlining it would spend the budget on what is already in context.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const RULES_FILE_MAX_BYTES = 8000;
export const RULES_TOTAL_MAX_BYTES = 9000;
export const RULES_MIN_BYTES = 200;
export const MAX_WALK = 64;
export const NOTES_MAX_COUNT = 100;

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const canonical = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const within = (root, p) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** The nearest directory at or above `dir` holding a `.git` entry, or null. Never throws. */
export function findGitRoot(dir) {
  let d = dir;
  for (let i = 0; i < MAX_WALK; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}

/** The rules files one directory holds: `CLAUDE.md` (then `CLAUDE.local.md`) else `AGENTS.md`; []. */
export function rulesFilesIn(dir) {
  const claude = join(dir, "CLAUDE.md");
  if (isFile(claude)) {
    const local = join(dir, "CLAUDE.local.md");
    return isFile(local) ? [claude, local] : [claude];
  }
  const agents = join(dir, "AGENTS.md");
  return isFile(agents) ? [agents] : [];
}

/**
 * `{ start, root, rootKind, gitRoot, files, skipped }` for `cwd`: `files` root-first
 * (`{ path, bytes, content }`), `skipped` (`{ path, why }`) one per rules file on the walk that
 * was not read, `rootKind` one of "git", "workspace", "cwd". A cwd that does not exist walks
 * nothing and says so. Never throws.
 */
export function walkRules(cwd, env = process.env) {
  const out = { start: cwd ? String(cwd) : "", root: "", rootKind: "cwd", gitRoot: null, files: [], skipped: [], note: null };
  if (!cwd) return { ...out, note: "the payload carried no working directory, so nothing was walked" };
  let start;
  try {
    start = realpathSync(cwd);
    if (!statSync(start).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ...out, note: `\`${cwd}\` is not a directory that exists, so nothing was walked` };
  }
  out.start = start;
  const gitRoot = findGitRoot(start);
  out.gitRoot = gitRoot;
  let root = start;
  if (gitRoot) {
    root = gitRoot;
    out.rootKind = "git";
    const home = canonical(env.HOME || homedir());
    let d = dirname(gitRoot);
    for (let i = 0; i < MAX_WALK && d !== home && dirname(d) !== d; i++) {
      if (rulesFilesIn(d).length) {
        root = d;
        out.rootKind = "workspace";
        break;
      }
      d = dirname(d);
    }
  }
  out.root = root;
  const launch = typeof env.CLAUDE_PROJECT_DIR === "string" && env.CLAUDE_PROJECT_DIR.trim() ? canonical(env.CLAUDE_PROJECT_DIR) : null;
  const levels = [];
  for (let d = start, i = 0; i < MAX_WALK; i++) {
    levels.push(d);
    if (d === root || dirname(d) === d) break;
    d = dirname(d);
  }
  const seen = new Map();
  for (const dir of levels.reverse()) {
    for (const path of rulesFilesIn(dir)) {
      if (launch && within(dir, launch)) {
        out.skipped.push({ path, why: "loaded by the host at launch (the directory is CLAUDE_PROJECT_DIR or above it) and kept across the compaction" });
        continue;
      }
      let real = path;
      try {
        if (lstatSync(path).isSymbolicLink()) {
          real = realpathSync(path);
          if (!within(root, real)) {
            out.skipped.push({ path, why: `a symlink to \`${real}\`, outside the walk root` });
            continue;
          }
        }
      } catch (err) {
        out.skipped.push({ path, why: `unreadable (${err?.code ?? "error"})` });
        continue;
      }
      if (seen.has(real)) {
        out.skipped.push({ path, why: `the same file as \`${seen.get(real)}\`, already inlined` });
        continue;
      }
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch (err) {
        out.skipped.push({ path, why: `unreadable (${err?.code ?? "error"})` });
        continue;
      }
      if (!content.trim()) {
        out.skipped.push({ path, why: "empty" });
        continue;
      }
      seen.set(real, path);
      out.files.push({ path, bytes: Buffer.byteLength(content, "utf8"), content });
    }
  }
  return out;
}

/** The first `n` bytes of `text` as a string, cut on a character boundary. */
export function truncateBytes(text, n) {
  return Buffer.from(text, "utf8").subarray(0, Math.max(0, n)).toString("utf8").replace(/\uFFFD+$/, "");
}

/**
 * Which files land and at what size, within `totalBytes` (capped at RULES_TOTAL_MAX_BYTES) and
 * `perFileBytes`: the smallest files whole, the largest cut to the one allowance that fits the
 * total (water-filling), a file whose allowance would be under RULES_MIN_BYTES skipped. Returns
 * `{ shown: [{ path, bytes, content, shownBytes }], skipped: [{ path, why }] }`, shown in input
 * order.
 */
export function fitRules(files, totalBytes, perFileBytes = RULES_FILE_MAX_BYTES) {
  const total = Math.min(Math.max(0, Math.floor(totalBytes)), RULES_TOTAL_MAX_BYTES);
  const sizes = files.map((f) => Math.min(f.bytes, perFileBytes)).sort((a, b) => a - b);
  let allowance = perFileBytes;
  let remaining = total;
  for (let i = 0; i < sizes.length; i++) {
    const left = sizes.length - i;
    if (sizes[i] * left <= remaining) remaining -= sizes[i];
    else {
      allowance = Math.floor(remaining / left);
      break;
    }
  }
  const shown = [];
  const skipped = [];
  for (const f of files) {
    const give = Math.min(f.bytes, perFileBytes, allowance);
    if (give >= f.bytes) shown.push({ ...f, shownBytes: f.bytes });
    else if (give >= RULES_MIN_BYTES) shown.push({ ...f, shownBytes: give });
    else skipped.push({ path: f.path, why: total < RULES_MIN_BYTES ? `no room: the snapshot used the restore budget (${total} bytes left for rules)` : `no room: the rules on this walk total ${files.reduce((n, x) => n + x.bytes, 0)} bytes against a ${total}-byte section cap, and this file's share would be under ${RULES_MIN_BYTES}` });
  }
  return { shown, skipped };
}

/**
 * The `## Repo rules re-inlined` section for `walk` (from `walkRules`) within `budgetBytes`.
 * Always a section: one that found nothing says so, one that could inline nothing names every
 * file and why.
 */
export function renderRules(walk, budgetBytes = RULES_TOTAL_MAX_BYTES) {
  const lines = ["## Repo rules re-inlined", ""];
  if (walk.note) {
    lines.push(`(${walk.note})`);
    return `${lines.join("\n")}\n`;
  }
  const rootWhy = walk.rootKind === "git" ? "the git root" : walk.rootKind === "workspace" ? `the nearest directory above the git root \`${walk.gitRoot}\` holding a rules file` : "the cwd itself, with no git root above it";
  lines.push(`The host does not re-read these after a compaction. Walked from \`${walk.start}\` up to \`${walk.root}\` (${rootWhy}); root first, nearest last, so the nearest file's rules win.`);
  const { shown, skipped } = fitRules(walk.files, budgetBytes);
  if (!walk.files.length && !walk.skipped.length) lines.push("", "(no CLAUDE.md, CLAUDE.local.md or AGENTS.md on that walk)");
  for (const f of shown) {
    lines.push("", `### \`${f.path}\` (${f.bytes} bytes)`, "");
    if (f.shownBytes >= f.bytes) lines.push(f.content.trimEnd());
    else lines.push(truncateBytes(f.content, f.shownBytes).trimEnd(), "", `(truncated at ${f.shownBytes} bytes; the file is ${f.bytes} bytes, read it for the rest)`);
  }
  const allSkipped = [...walk.skipped, ...skipped];
  if (allSkipped.length) {
    lines.push("");
    for (const s of allSkipped) lines.push(`- skipped \`${s.path}\`: ${s.why}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The `## Durable notes` section: the newest `count` regular files of `dir` by modification
 * time (dot-files left out), one filename per line, with the sentence that the notes and the
 * rules files are the source of truth. `dir` is taken relative to `base` unless absolute; an
 * absent directory is one line saying so. Never throws.
 */
export function renderNotes(dir, base, count) {
  const n = Math.min(Math.max(0, Math.floor(count)), NOTES_MAX_COUNT);
  const abs = isAbsolute(dir) ? dir : resolve(base, dir);
  const lines = [`## Durable notes (\`${abs}\`)`, ""];
  let names;
  try {
    names = readdirSync(abs);
  } catch (err) {
    lines.push(err?.code === "ENOENT" || err?.code === "ENOTDIR" ? `(no notes directory at \`${abs}\`)` : `(the notes directory could not be read: ${err?.code ?? "error"})`);
    return `${lines.join("\n")}\n`;
  }
  const entries = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const st = statSync(join(abs, name));
      if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* gone between readdir and stat */
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  if (!entries.length) lines.push("(the notes directory is empty)");
  else {
    lines.push(`The newest ${Math.min(n, entries.length)} of ${entries.length} entries by modification time:`, "");
    for (const e of entries.slice(0, n)) lines.push(`- ${e.name}`);
  }
  lines.push("", "> The notes directory and the rules files are the source of truth; the restored snapshot is only the safety net. Read the newest note before continuing a thread it covers.");
  return `${lines.join("\n")}\n`;
}
