// lib/handoffs.mjs — where a repository's agent-authored handoffs live, which ones are open and
// fresh, and how they render into a session. The `handoff` skill writes them; the PreCompact
// snapshot inlines them so they survive compaction. One root-resolution algorithm and one
// staleness rule for the writer and the reader, so a handoff written under one root is never
// silently unread from another.
//
// Fail-quiet: a git failure, an unreadable directory or a malformed file is skipped, never
// thrown. A hook must never crash a session over a handoff.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";

export const HANDOFFS_DIR = ".ai/handoffs";
export const STALE_DAYS = 7;
export const SHOW_FULL = 3;
// Per-entry cap on lines for a fully-shown handoff; without it one long body gets inlined
// verbatim, up to SHOW_FULL of them, on every compaction.
export const ENTRY_LINE_CAP = 120;

// Each of the two root lookups gets at most this long; the PreCompact save has a 2 s budget for
// all of its git calls, and these run beside its branch and status calls inside that budget.
export const ROOT_GIT_TIMEOUT_MS = 500;

/**
 * The handoff root for `cwd`, in this order (the skill resolves it the same way):
 *   1. `CLAUDE_PROJECT_DIR`, if set and it exists.
 *   2. The main worktree root: `git rev-parse --path-format=absolute --git-common-dir` with a
 *      trailing `/.git` stripped (plain `--git-common-dir` is relative to cwd), so every
 *      worktree of one repository shares one handoff pool.
 *   3. `git rev-parse --show-toplevel`.
 *   4. `cwd`.
 * `{ root, note }`: `note` is null, or says that git timed out and the root fell back, so a
 * caller can say where it looked. Each git call is capped at ROOT_GIT_TIMEOUT_MS and at what is
 * left of `budget` (lib/git.mjs) when one is passed.
 */
export async function resolveHandoffRoot(cwd, env = process.env, { budget: b = null } = {}) {
  const base = cwd || process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (projectDir && existsSync(projectDir)) return { root: projectDir, note: null };
  const limit = () => (b ? b.left(ROOT_GIT_TIMEOUT_MS) : ROOT_GIT_TIMEOUT_MS);
  let timedOut = false;
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], base, limit());
  if (common.ok && common.out) {
    const root = common.out.replace(/\/\.git$/, "");
    if (root && existsSync(root)) return { root, note: null };
  }
  if (!common.ok && common.reason === "timed out") timedOut = true;
  const top = await git(["rev-parse", "--show-toplevel"], base, limit());
  if (top.ok && top.out && existsSync(top.out)) return { root: top.out, note: null };
  if (!top.ok && top.reason === "timed out") timedOut = true;
  return { root: base, note: timedOut ? `git did not answer in time, so the handoff root fell back to \`${base}\`` : null };
}

/** `---\nkey: value\n---\nbody` split; null when the text has no frontmatter. */
export function parseFrontmatter(raw) {
  const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

/** Open handoffs under `<root>/.ai/handoffs/` with an mtime inside STALE_DAYS, newest first. */
export function listHandoffs(root, now = Date.now()) {
  const dir = join(root, HANDOFFS_DIR);
  const cutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < cutoff) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || !parsed.body) continue;
    if ((parsed.meta.status || "open") !== "open") continue;
    entries.push({
      path,
      mtimeMs: st.mtimeMs,
      lane: parsed.meta.lane || "unknown",
      author: parsed.meta.author || "unknown",
      session: parsed.meta.session_id || "",
      date: (parsed.meta.created || "").slice(0, 10) || new Date(st.mtimeMs).toISOString().slice(0, 10),
      body: parsed.body,
    });
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Cuts at a `## ` boundary at or before the cap when there is one above the first line, so the
// shown text does not end mid-sentence; the marker names the shown and total line counts and
// the full file's path. Never silent.
function truncateBody(body, path) {
  const lines = body.split("\n");
  if (lines.length <= ENTRY_LINE_CAP) return body;
  let cut = ENTRY_LINE_CAP;
  for (let i = Math.min(ENTRY_LINE_CAP, lines.length - 1); i > 0; i--) {
    if (lines[i].startsWith("## ")) {
      cut = i;
      break;
    }
  }
  return `${lines.slice(0, cut).join("\n")}\n\n_(truncated at ${cut} of ${lines.length} lines; full note: ${path})_`;
}

/** The markdown block: the newest SHOW_FULL in full, one index line each for the rest, and the suppressed count. "" when there is nothing. */
export function renderHandoffs(root, now = Date.now()) {
  const entries = listHandoffs(root, now);
  if (!entries.length) return "";
  const shown = entries.slice(0, SHOW_FULL);
  const rest = entries.slice(SHOW_FULL);
  const lines = [`## Open handoffs (${entries.length})`];
  for (const e of shown) {
    lines.push("", `### ${e.date} · ${e.author} · ${e.lane}`, truncateBody(e.body, e.path));
  }
  if (rest.length) {
    lines.push("");
    for (const e of rest) lines.push(`- ${e.date} · ${e.author} · ${e.lane}`);
    lines.push("", `(${rest.length} more suppressed; see ${HANDOFFS_DIR}/)`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The mtime (ms) of the newest open, fresh handoff under `root` whose frontmatter `session_id`
 * is `sessionId`; null when there is none (or no session id).
 */
export function lastHandoffBy(root, sessionId, now = Date.now()) {
  if (!sessionId) return null;
  const mine = listHandoffs(root, now).find((e) => e.session === String(sessionId));
  return mine ? mine.mtimeMs : null;
}
