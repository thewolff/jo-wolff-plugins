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
// and RULES_TOTAL_MAX_BYTES for the whole rendered section, the per-file cap the one the source
// hook applied to each rules file and the total the one its sibling hook used for injecting one
// rules chain live. The section cap counts everything the section prints: the heading, the walk
// line, each file's heading and path, the truncation markers and every skip line, not only the
// file bodies. The caller passes what remains of the restore's own character guard (lib/snapshot.mjs
// RESTORE_MAX_CHARS) after the snapshot, so the section can never push the restore past it; the
// rules are what gives way first. Within the cap, the smallest files land whole and the largest are
// cut on a UTF-8 boundary, each cut announced in-band (`(truncated at N bytes …)`, N the bytes
// shown); a file that would get less than RULES_MIN_BYTES is skipped and named instead of inlined
// as a stub. Skip lines that do not fit are counted in one closing line; a cap too small for the
// heading and that line renders nothing, and the caller names the omission.

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
 * Which files land and at what size, within `totalBytes` of file text (capped at
 * RULES_TOTAL_MAX_BYTES) and `perFileBytes`: the smallest files whole, the largest cut to the one
 * allowance that fits the total (water-filling), a file whose allowance would be under
 * RULES_MIN_BYTES skipped. `cause`, when given, is appended to the skip reason. Returns
 * `{ shown: [{ path, bytes, content, shownBytes }], skipped: [{ path, why }] }`, shown in input
 * order.
 */
export function fitRules(files, totalBytes, perFileBytes = RULES_FILE_MAX_BYTES, cause = "") {
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
  const sum = files.reduce((n, x) => n + x.bytes, 0);
  for (const f of files) {
    const give = Math.min(f.bytes, perFileBytes, allowance);
    if (give >= f.bytes) shown.push({ ...f, shownBytes: f.bytes });
    else if (give >= RULES_MIN_BYTES) shown.push({ ...f, shownBytes: give });
    else skipped.push({ path: f.path, why: total < RULES_MIN_BYTES ? `no room: ${total} bytes left for rules text${cause}` : `no room: the rules on this walk total ${sum} bytes against ${total} bytes left for rules text${cause}, and this file's share would be under ${RULES_MIN_BYTES}` });
  }
  return { shown, skipped };
}

const byteLength = (s) => Buffer.byteLength(s, "utf8");

/**
 * The `## Repo rules re-inlined` section for `walk` (from `walkRules`), the whole rendered string
 * at most `budgetBytes` (capped at RULES_TOTAL_MAX_BYTES) UTF-8 bytes. One that found nothing
 * says so; one that could inline nothing names every file and why, as many skip lines as fit and
 * a count of the rest. A budget too small for even the heading and that count is "" (the caller
 * names the omission).
 */
export function renderRules(walk, budgetBytes = RULES_TOTAL_MAX_BYTES) {
  const cap = Math.min(Math.max(0, Math.floor(budgetBytes)), RULES_TOTAL_MAX_BYTES);
  const finish = (lines) => `${lines.join("\n")}\n`;
  const fits = (text) => byteLength(text) <= cap;
  const head = ["## Repo rules re-inlined", ""];
  if (walk.note) {
    const text = finish([...head, `(${walk.note})`]);
    return fits(text) ? text : "";
  }
  const rootWhy = walk.rootKind === "git" ? "the git root" : walk.rootKind === "workspace" ? `the nearest directory above the git root \`${walk.gitRoot}\` holding a rules file` : "the cwd itself, with no git root above it";
  head.push(`The host does not re-read these after a compaction. Walked from \`${walk.start}\` up to \`${walk.root}\` (${rootWhy}); root first, nearest last, so the nearest file's rules win.`);
  if (!walk.files.length && !walk.skipped.length) {
    const text = finish([...head, "", "(no CLAUDE.md, CLAUDE.local.md or AGENTS.md on that walk)"]);
    return fits(text) ? text : "";
  }
  const cause = cap < RULES_TOTAL_MAX_BYTES ? ` (the snapshot used the rest of the restore guard)` : "";
  // The file bodies get what the framing leaves: render, measure, and give the bodies less by the
  // overshoot until the whole section fits. Each pass shrinks the allowance, so this ends at 0.
  let bodies = Math.min(cap, walk.files.reduce((n, f) => n + Math.min(f.bytes, RULES_FILE_MAX_BYTES), 0));
  for (let pass = 0; pass < 32; pass++) {
    const text = compose(walk, head, fitRules(walk.files, bodies, RULES_FILE_MAX_BYTES, cause));
    const over = byteLength(text) - cap;
    if (over <= 0) return text;
    if (bodies === 0) break;
    bodies = pass < 31 ? Math.max(0, bodies - over) : 0;
  }
  // Nothing inlines and the skip lines alone overrun the cap: as many as fit, then a count of the rest.
  const skips = [...walk.skipped, ...fitRules(walk.files, 0, RULES_FILE_MAX_BYTES, cause).skipped].map((s) => `- skipped \`${s.path}\`: ${s.why}`);
  for (const lead of [head, head.slice(0, 1)]) {
    for (let k = skips.length - 1; k >= 0; k--) {
      const text = finish([...lead, "", ...skips.slice(0, k), `- ${skips.length - k} more rules file${skips.length - k === 1 ? "" : "s"} not inlined and not listed: no room in the section`]);
      if (fits(text)) return text;
    }
  }
  return "";
}

function compose(walk, head, { shown, skipped }) {
  const lines = [...head];
  for (const f of shown) {
    lines.push("", `### \`${f.path}\` (${f.bytes} bytes)`, "");
    if (f.shownBytes >= f.bytes) lines.push(f.content.trimEnd());
    else {
      const cut = truncateBytes(f.content, f.shownBytes).trimEnd();
      lines.push(cut, "", `(truncated at ${byteLength(cut)} bytes; the file is ${f.bytes} bytes, read it for the rest)`);
    }
  }
  const allSkipped = [...walk.skipped, ...skipped];
  if (allSkipped.length) {
    lines.push("");
    for (const s of allSkipped) lines.push(`- skipped \`${s.path}\`: ${s.why}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The directory a relative `notesDir` hangs off: the git root above the real cwd, else the real cwd. */
export function notesRoot(cwd) {
  const start = canonical(cwd ? String(cwd) : process.cwd());
  return findGitRoot(start) || start;
}

/**
 * The `## Durable notes` section: the newest `count` regular files of `dir` by modification
 * time (dot-files left out), one filename per line, with the sentence that the notes and the
 * rules files are the source of truth. `dir` is taken relative to `base` unless absolute; an
 * absent directory is one line saying so. The whole rendered string is at most `budgetBytes`
 * UTF-8 bytes: the list gives way first, then the section is "" (the caller names the omission).
 * Never throws.
 */
export function renderNotes(dir, base, count, budgetBytes = Infinity) {
  const n = Math.min(Math.max(0, Math.floor(count)), NOTES_MAX_COUNT);
  const abs = isAbsolute(dir) ? dir : resolve(base, dir);
  const heading = [`## Durable notes (\`${abs}\`)`, ""];
  const fits = (text) => byteLength(text) <= budgetBytes;
  const finish = (lines) => {
    const text = `${lines.join("\n")}\n`;
    return fits(text) ? text : "";
  };
  let names;
  try {
    names = readdirSync(abs);
  } catch (err) {
    return finish([...heading, err?.code === "ENOENT" || err?.code === "ENOTDIR" ? `(no notes directory at \`${abs}\`)` : `(the notes directory could not be read: ${err?.code ?? "error"})`]);
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
  const truth = ["", "> The notes directory and the rules files are the source of truth; the restored snapshot is only the safety net. Read the newest note before continuing a thread it covers."];
  if (!entries.length) return finish([...heading, "(the notes directory is empty)", ...truth]);
  for (let k = Math.min(n, entries.length); k >= 1; k--) {
    const text = finish([...heading, `The newest ${k} of ${entries.length} entries by modification time:`, "", ...entries.slice(0, k).map((e) => `- ${e.name}`), ...truth]);
    if (text) return text;
  }
  return finish([...heading, `(${entries.length} entries; ${n ? "no room left in the restore guard to list them" : "none listed"})`, ...truth]);
}
