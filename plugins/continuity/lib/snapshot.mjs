// lib/snapshot.mjs — the pre-compaction save and the post-compaction restore.
//
// `capture(input)` writes `<state>/<session>.json`: the deterministic facts of the session at
// the moment of compaction (branch, uncommitted paths, files touched, recent asks) plus the
// agent-authored handoffs from the repository's `.ai/handoffs/`, each section naming its
// source. It does not try to infer decisions: that is the agent's job, and the handoff skill is
// where that judgment is written. `restore(input)` renders the same session's snapshot back as
// markdown for the SessionStart(compact) hook to inject, then unlinks it.
//
// Design notes, carried from the hook this was ported from:
//   - Deterministic facts only. A section that was unavailable says so, in the file; a blank
//     section never reads as "nothing happened".
//   - Every capture is capped at the point of capture (a dirty tree once produced a 990 KB
//     save), and the restore is capped again on the read: a restore that can exceed the context
//     it is restoring into is wrong whatever the save captured. 20,000 characters is about 5k
//     tokens, roughly twice what a rules-injection hook may push into a session at once.
//   - Every truncation is announced in-band. A silently shortened `git status` reads as a clean
//     tree.
//   - A truncated restore keeps its file and says where it is; a complete one unlinks it, so a
//     stale snapshot is never re-injected into a later, unrelated session start. A snapshot older
//     than a day is never injected at all; prune removes it after 30.
//   - Fail-quiet on the read side, honest on the write side: a snapshot that could not be
//     written returns `failed:<reason>`, and the heartbeat records it.

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { budget, git } from "./git.mjs";
import { renderHandoffs, resolveHandoffRoot } from "./handoffs.mjs";
import { sanitizeSessionId, snapshotPath } from "./paths.mjs";

export const SNAPSHOT_VERSION = 2;
export const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_STATUS_ENTRIES = 40;
export const MAX_TOUCHED_FILES = 40;
export const MAX_INTENTS = 5;
export const MAX_SECTION_CHARS = 8000;
export const RESTORE_MAX_CHARS = 20000;
// Every git call the save makes runs at once and shares this one wall-clock budget (the two
// handoff-root lookups are also capped at 500 ms each, lib/handoffs.mjs), so the repository
// reads cost at most 2 s whatever the checkout does, and the snapshot is written inside the
// runner's 4 s deadline. A call still running at the budget is killed and its field is saved
// as `(unknown: timed out)`: the snapshot is written anyway, never dropped for want of git.
export const GIT_BUDGET_MS = 2000;

/** `{ lines, total }`: the first `max` lines; `total` says how many there were. */
export function capLines(text, max) {
  const lines = String(text || "").split("\n").filter((l) => l !== "");
  return { lines: lines.slice(0, max), total: lines.length };
}

/** The text with a marker when it was cut, or itself. */
export function capChars(text, max, what, hint = "") {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n… TRUNCATED: ${what} was ${s.length} characters, ${max} shown.${hint ? ` ${hint}` : ""}`;
}

/** The rendering of a capped list, announcing what is not shown. */
function listBlock({ lines, total }, what, hint = "") {
  if (!total) return "";
  const out = lines.map((l) => `- ${l}`).join("\n");
  if (total <= lines.length) return out;
  return `${out}\n… TRUNCATED: ${total - lines.length} more ${what} not shown (${total} total).${hint ? ` ${hint}` : ""}`;
}

// One short token for the heartbeat's `failed:` outcome: the error code when there is one.
export function failureReason(err) {
  const code = err && typeof err === "object" && err.code ? String(err.code) : "";
  return (code || (err && err.message ? String(err.message) : "error")).replace(/\s+/g, " ").slice(0, 120);
}

// What a git answer that never came reads as in the snapshot: "timed out", or the failed
// command and its exit. Never "", which a reader would take for "nothing to report".
const unknownWhy = (r, what) => (r.reason === "timed out" ? "timed out" : `${what} failed (${r.reason})`);

/** `{ lines, total, unknown }` for a git listing: `unknown` null when git answered. */
const gitList = (r, max, what) => (r.ok ? { ...capLines(r.out, max), unknown: null } : { lines: [], total: 0, unknown: unknownWhy(r, what) });

/** Prompts and edited paths read from a Claude Code transcript (JSONL); `read` false when it could not be read. */
export function readTranscript(path) {
  const prompts = [];
  const touched = new Set();
  let lines;
  try {
    lines = readFileSync(String(path), "utf8").split("\n").filter(Boolean);
  } catch {
    return { read: false, prompts, touched: [] };
  }
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = e?.message ?? e;
    const content = msg?.content;
    if (msg?.role === "user" && typeof content === "string") prompts.push(content);
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && msg?.role === "user" && typeof b.text === "string") prompts.push(b.text);
        // Exact tool-name match: a substring test also matched unrelated tools whose names merely contain "Edit".
        if (b?.type === "tool_use" && /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name || "")) {
          const p = b.input?.file_path || b.input?.path;
          if (p) touched.add(String(p));
        }
      }
    }
  }
  return { read: true, prompts, touched: [...touched] };
}

/**
 * The snapshot object for a PreCompact input: pure apart from reading the transcript, the
 * repository (every git call at once, inside one GIT_BUDGET_MS budget) and the handoffs. `now`
 * and `gitBudgetMs` are injectable.
 */
export async function buildSnapshot(input, { env = process.env, now = new Date(), gitBudgetMs = GIT_BUDGET_MS } = {}) {
  const cwd = String(input?.cwd || "") || process.cwd();
  const transcript = readTranscript(input?.transcript_path);

  // Intent has two possible sources and the transcript is the preferred one: `intents` is
  // absent from every Claude Code payload, and a readable transcript that yielded prompts
  // always wins. A host with no transcript concept sends the same facts on the payload instead.
  // The snapshot names which one it used, so a reader can tell a degraded save from a full one.
  const transcriptPrompts = transcript.prompts.filter((p) => typeof p === "string" && p.trim() && !p.startsWith("<"));
  const hostIntents = Array.isArray(input?.intents) ? input.intents.filter((p) => typeof p === "string" && p.trim()) : [];
  const useTranscript = transcript.read && transcriptPrompts.length > 0;
  const intents = (useTranscript ? transcriptPrompts : hostIntents).slice(-MAX_INTENTS).map((p) => p.replace(/\s+/g, " ").slice(0, 200));
  const intentSource = useTranscript
    ? "session transcript"
    : hostIntents.length
      ? "host-supplied `intents` (no readable transcript on this payload)"
      : "none available: neither a readable transcript nor host-supplied intents";

  const hostFileOps = typeof input?.file_operations === "string" && input.file_operations.trim() ? capChars(input.file_operations.trim(), MAX_SECTION_CHARS, "the host's file-operation record") : "";
  const hostJudgment = Array.isArray(input?.agent_judgment) ? input.agent_judgment.filter((p) => typeof p === "string" && p.trim()).map((p) => p.replace(/\s+/g, " ")) : [];
  const filesSource = transcript.read
    ? "session transcript: write and edit calls only, reads are not counted"
    : hostFileOps
      ? "nothing derived: no readable transcript on this payload; see the host-supplied file operations, which the host did supply"
      : "nothing derived: no readable transcript on this payload and no host-supplied record either";

  // Degraded means the session's own view is wholly absent: then the repository is a
  // reconstruction, not a record, and the snapshot says so. A payload carrying any of the four
  // told us something about the session itself, and the fallback stands down.
  const missing = [];
  if (!transcript.read) missing.push("no readable `transcript_path` on the payload");
  if (!hostIntents.length) missing.push("no host-supplied `intents`");
  if (!hostFileOps) missing.push("no host-supplied `file_operations`");
  if (!hostJudgment.length) missing.push("no host-supplied `agent_judgment`");
  const degraded = missing.length === 4;
  const captureSource = transcript.read ? "session transcript" : !degraded ? "host-supplied payload fields" : "repository only: the session's own view was not available";

  // Every repository read starts now and shares one deadline; nothing below waits on git longer.
  const b = budget(gitBudgetMs);
  const rootP = resolveHandoffRoot(cwd, env, { budget: b });
  const branchP = git(["branch", "--show-current"], cwd, b.left());
  const statusP = git(["status", "--short"], cwd, b.left());
  const commitsP = degraded ? git(["log", "--oneline", "--no-decorate", "-12"], cwd, b.left()) : null;
  const unpushedP = degraded ? git(["log", "--oneline", "--no-decorate", "@{u}..HEAD"], cwd, b.left()) : null;
  const [{ root: handoffRoot, note: rootNote }, branch, status, commits, unpushed] = await Promise.all([rootP, branchP, statusP, commitsP, unpushedP]);

  let handoff = "";
  try {
    handoff = capChars(renderHandoffs(handoffRoot).trim(), MAX_SECTION_CHARS, "the handoff section", `Read \`${handoffRoot}/.ai/handoffs/\` for the rest.`);
  } catch {
    handoff = "";
  }

  return {
    version: SNAPSHOT_VERSION,
    at: now.toISOString(),
    trigger: String(input?.trigger || "?"),
    session: sanitizeSessionId(input?.session_id),
    cwd,
    captureSource,
    // "" from a git that answered is a detached HEAD; null with branchUnknown is no answer.
    branch: branch.ok ? branch.out || null : null,
    branchUnknown: branch.ok ? null : unknownWhy(branch, "git branch"),
    status: gitList(status, MAX_STATUS_ENTRIES, "git status"),
    filesTouched: { source: filesSource, ...capLines(transcript.touched.join("\n"), MAX_TOUCHED_FILES) },
    hostFileOperations: hostFileOps || null,
    recentIntent: { source: intentSource, lines: intents },
    hostJudgment: capChars(hostJudgment.map((p) => `- ${p}`).join("\n"), MAX_SECTION_CHARS, "the host-supplied judgment section", "The compacting host holds the rest.") || null,
    handoff: { root: handoffRoot, present: Boolean(handoff), text: handoff || null, note: rootNote },
    reconstruction: degraded
      ? {
          missing,
          recentCommits: gitList(commits, 12, "git log"),
          // `@{u}` fails on a branch with no upstream, which is an answer: nothing is known to be
          // unpushed. Only a timeout leaves it unknown.
          unpushed: unpushed.ok || unpushed.reason !== "timed out" ? { ...capLines(unpushed.ok ? unpushed.out : "", 12), unknown: null } : gitList(unpushed, 12, "git log"),
        }
      : null,
  };
}

/** The markdown a snapshot renders to: what the post-compaction session reads. */
export function renderSnapshot(s) {
  const parts = [
    `# Session state (auto-captured before compaction)`,
    `_${s.at} · trigger: ${s.trigger} · capture source: ${s.captureSource}_`,
    ``,
    `## Branch`,
    s.branch || (s.branchUnknown ? `(unknown: ${s.branchUnknown})` : "(none: detached HEAD, or no branch yet)"),
    ``,
    `## Uncommitted changes`,
    // A git status that did not answer is unknown, never clean: "(clean)" only from an answer.
    s.status.unknown
      ? `(unknown: ${s.status.unknown}; run \`git status --short\` before assuming the tree is clean)`
      : listBlock(s.status, "changed paths", "Run `git status --short` for the full list; this is a resumption payload, not a diagnostic.") || "(clean)",
    ``,
    `## Files touched this session`,
    `_source: ${s.filesTouched.source}_`,
    ``,
    listBlock(s.filesTouched, "files touched") || "(none detected)",
  ];
  if (s.hostFileOperations) parts.push(``, `## Host-supplied file operations`, `_the compacting host's own record, not derived from a transcript_`, ``, s.hostFileOperations);
  parts.push(``, `## Recent intent (last user asks)`, `_source: ${s.recentIntent.source}_`, ``, s.recentIntent.lines.map((l) => `- ${l}`).join("\n") || "(none captured)");
  if (s.reconstruction) {
    parts.push(
      ``,
      `## Capture was degraded: this is a reconstruction, not a record`,
      ``,
      `The session's own view of itself did not reach the hook: ${s.reconstruction.missing.join("; ")}. So "Files touched this session" and "Recent intent" above are blank BECAUSE THEY WERE UNAVAILABLE, not because nothing happened. Everything in this section is derived from the repository at \`${s.cwd}\`, so it shows what the repository looked like, never what was being attempted or why.`,
      ``,
      `### Recent commits`,
      ``,
      s.reconstruction.recentCommits.unknown ? `(unknown: ${s.reconstruction.recentCommits.unknown})` : listBlock(s.reconstruction.recentCommits, "commits", "Run `git log` for more.") || "(none)",
      ``,
      `### Committed but not pushed`,
      ``,
      s.reconstruction.unpushed.unknown ? `(unknown: ${s.reconstruction.unpushed.unknown})` : listBlock(s.reconstruction.unpushed, "unpushed commits") || "(none, or no upstream to compare against)",
    );
  }
  if (s.handoff.present) {
    parts.push(
      ``,
      `## Agent-authored handoff (from \`${s.handoff.root}/.ai/handoffs/\`)`,
      ``,
      `This section was written by prior sessions, not derived by the hook. It is the only part of this file that carries judgment; treat its labels as they stand. The open-status and 7-day staleness filters were already applied.`,
      ``,
      s.handoff.text,
    );
  }
  if (s.hostJudgment) parts.push(``, `## Host-supplied agent judgment`, `_the agent's own words as the host recorded them, not derived by this hook_`, ``, s.hostJudgment);
  parts.push(``, `> Rebuild from here. The repository and its committed record are the source of truth; this file is only the in-flight scratch state.`);
  if (s.handoff.note) parts.push(`> Handoff lookup: ${s.handoff.note}; handoffs under the repository's main root may not have been read.`);
  if (!s.handoff.present) {
    parts.push(
      s.hostJudgment
        ? `> **No agent-authored handoff was written before this compaction.** What the hook derived above is mechanical: branch, diff, files, prompts. The judgment layer is not absent: the host supplied the agent's own words under "Host-supplied agent judgment" above. Read them as raw replies the host happened to record, nothing selected, ordered or ruled out, never as a curated handoff.`
        : `> **No agent-authored handoff was written before this compaction.** Everything above is mechanical: branch, diff, files, prompts. The judgment layer (what was being attempted, what was already ruled out, what is still uncertain) was NOT captured and is not recoverable from this file. Do not treat these facts as a complete account of the session. Reconstruct intent from the repository, and say plainly that you are reconstructing rather than resuming.`,
    );
  }
  return `${parts.join("\n")}\n`;
}

/**
 * Build and write the snapshot for a PreCompact input. Returns `{ outcome, snapshot, path }`
 * where outcome is "ok" or "failed:<reason>"; never throws.
 */
export async function capture(input, { env = process.env, now = new Date(), gitBudgetMs = GIT_BUDGET_MS } = {}) {
  const path = snapshotPath(input?.session_id, env);
  let snapshot = null;
  try {
    snapshot = await buildSnapshot(input, { env, now, gitBudgetMs });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    return { outcome: "ok", snapshot, path };
  } catch (err) {
    return { outcome: `failed:${failureReason(err)}`, snapshot, path };
  }
}

/**
 * The markdown to inject after a compaction for this session, or null when there is no fresh
 * snapshot of its own. A complete restore unlinks the file; an over-budget one shows the head,
 * says so, and keeps the file.
 */
export function restore(input, { env = process.env, now = Date.now() } = {}) {
  const path = snapshotPath(input?.session_id, env);
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isFile() || now - st.mtimeMs > STATE_MAX_AGE_MS) return null;
  let body;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    body = renderSnapshot(json);
  } catch {
    return null;
  }
  const retain = body.length > RESTORE_MAX_CHARS;
  const hasHandoff = body.includes("## Agent-authored handoff");
  const text =
    "## Restored session state (post-compaction)\n\n" +
    "Re-read the files listed below before continuing. The repository is canonical; this scratch state only says where you left off. " +
    "Before continuing any thread from it, restate what the thread is and what is pending on it, in content, not by name.\n\n" +
    (retain
      ? `**TRUNCATED: this snapshot is ${body.length} characters and only the first ${RESTORE_MAX_CHARS} are shown.** A restore that refills the window the compaction just cleared is worse than no restore, so the rest is withheld. The complete file is kept at \`${path}\`; read it directly if a section is missing below, and do not assume what follows is the whole snapshot.\n\n`
      : "") +
    (hasHandoff
      ? "This snapshot includes an agent-authored handoff section. That section carries the previous session's judgment and its labels; start from it. Everything outside it is mechanical fact.\n\n"
      : "**No handoff was written before compaction.** What follows is mechanical only: branch, diff, files, prompts. Intent, ruled-out approaches and open questions were not captured. You are reconstructing, not resuming; say so rather than narrating inferred history as if you remembered it.\n\n") +
    (retain ? body.slice(0, RESTORE_MAX_CHARS) : body);
  if (!retain) {
    try {
      unlinkSync(path);
    } catch {
      /* fail-quiet: a snapshot that could not be unlinked ages out after a day */
    }
  }
  return text;
}
