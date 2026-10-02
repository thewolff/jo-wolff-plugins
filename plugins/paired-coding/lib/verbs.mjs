// verbs.mjs — the session-level adapter API every host shell calls.
//
// A host adapter is a thin shell: it maps its own events onto these functions.
//   verdict             before any host tool call        (Claude Code PreToolUse, OMP tool_call)
//   recordTrustedInput  on the host's human-input signal (Claude Code UserPromptSubmit, OMP input)
//   endSession          on host shutdown                 (Claude Code SessionEnd, OMP session end)
//   executeVerb         inside the execute path of each pair_* tool, on its final arguments
//
// Every function is inert for a session that never ran pair_start: it reads nothing but the
// activation marker's existence and creates no file. Every state change is one locked
// read-modify-write of state.json plus an append to journal.jsonl in the session directory.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  boundaryMatches, carryClosed, checkWrite, lastCardSeq, openRoadmapItems, pairBegin, pairDone, pairNote, pairPropose, roadmapRecord,
  pairStart, pairWriteProfile, recordInput, runEnd, runStart, sessionEnd, toolVerdict,
} from "../core/gate.mjs";
import {
  activated, appendJournal, defaultTempPaths, findRoot, loadState, makeIo, markActivated, reapGroups, saveState,
  recordRun, runPgids, runSandboxed, sandboxProblem, sessionDir, stateBase, withLock, withSession, writeSandboxed,
} from "./host-io.mjs";

/** Directories left out of every snapshot unless the user's own exclusions say otherwise. */
export const DEFAULT_EXCLUSIONS = Object.freeze([".git"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
/** How long a /clear carry marker stays usable. */
export const CARRY_MAX_AGE_MS = 10 * 60 * 1000;
const CARRY_DIR = "carry";

/** This plugin's own root, canonical. pair_run and the kernel-fenced writes never write under it. */
export const PLUGIN_ROOT = (() => {
  const p = join(dirname(fileURLToPath(import.meta.url)), "..");
  try { return realpathSync(p); } catch { return p; }
})();

/** `$PAIRED_CODING_STATE_DIR/<sessionId>` (base defaults to ~/.local/state/paired-coding), or null. */
export function sessionDirFor(sessionId, env = process.env) {
  return sessionDir(stateBase(env), sessionId);
}

function ioFor(dir, state) {
  return makeIo({
    root: state.root,
    exclusions: state.exclusions ?? [],
    reapRuns: (runIds) => { reapGroups(runPgids(dir, runIds)); },
  });
}

/**
 * The pre-call verdict for a host tool. Inert (allow, no file touched) unless activated.
 * @param {string} toolName  the bare tool name (an adapter maps its own pair_* tool names to bare ones)
 * @param {{ sessionDir: string, allow?: string[] }} ctx
 * @returns {{ allow: boolean, reason?: string, active: boolean }}
 */
export function verdict(toolName, ctx) {
  if (!ctx?.sessionDir || !activated(ctx.sessionDir)) return { allow: true, active: false };
  const state = loadState(ctx.sessionDir);
  if (state.phase === "inactive") return { allow: true, active: false };
  const v = toolVerdict(state, { toolName }, { allow: ctx.allow ?? [] }, makeIo({}));
  appendJournal(ctx.sessionDir, v.journal);
  return { allow: v.allow, reason: v.reason, active: true };
}

/**
 * Record one human turn. Only `source: "interactive"` is trusted (the core decides), and a
 * trusted turn that is exactly the stop phrase ends pairing (`stopped`). Inert unless activated.
 * ADAPTER MACHINERY ONLY: never reachable from a model-callable tool.
 * @param {{ sessionDir: string, text: string, source: string, meta?: object }} ctx
 * @returns {{ recorded: boolean, trusted: boolean, active: boolean, stopped?: boolean, changedSinceReadBack?: object[], unapproved?: object[] }}
 */
export function recordTrustedInput(ctx) {
  if (!ctx?.sessionDir || !activated(ctx.sessionDir)) return { recorded: false, trusted: false, active: false };
  const dir = ctx.sessionDir;
  const r = withSession(dir, {}, (s) => {
    const out = recordInput(s, { text: ctx.text, source: ctx.source }, ioFor(dir, s));
    if (ctx.meta && out.journal.length) out.journal = out.journal.map((e) => ({ ...e, ...ctx.meta }));
    return out;
  });
  if (r.stopped !== true) return { recorded: true, trusted: r.trusted === true, active: true };
  return { recorded: true, trusted: true, active: true, stopped: true, changedSinceReadBack: r.changedSinceReadBack ?? [], unapproved: r.unapproved ?? [] };
}

/** What a session replacing this one needs (carryInto), read without ending it; null unless pairing. */
export function pairingCarry(sessionDir) {
  if (!sessionDir || !activated(sessionDir)) return null;
  return carryOf(loadState(sessionDir));
}

function carryOf(s) {
  return s.phase !== "inactive" && s.root ? { root: s.root, exclusions: s.exclusions ?? [...DEFAULT_EXCLUSIONS], protect: s.protect ?? [] } : null;
}

/**
 * Session end: reap every run, final snapshot, go inactive. Inert unless activated. When the
 * session was pairing, `carry` holds what a session that replaces it needs (carryInto).
 */
export function endSession(ctx) {
  if (!ctx?.sessionDir || !activated(ctx.sessionDir)) return { ok: true, active: false };
  let carry = null;
  const r = withSession(ctx.sessionDir, {}, (s) => {
    carry = carryOf(s);
    return sessionEnd(s, ioFor(ctx.sessionDir, s));
  });
  return { ok: r.ok, active: true, carry, changedSinceReadBack: r.changedSinceReadBack ?? [], unapproved: r.unapproved ?? [] };
}

/**
 * The conversation was cleared but the session kept its id (OMP /clear): end pairing as a
 * session change would (reap, final snapshot judged, unapproved writes journaled), then carry the
 * same session closed. Inert unless the session was pairing.
 * @param {{ sessionId: string, sessionDir: string, reason: string }} ctx
 */
export function clearInPlace(ctx) {
  const ended = endSession({ sessionDir: ctx.sessionDir });
  if (!ended.carry) return { ok: true, carried: false };
  const r = carryInto({ sessionId: ctx.sessionId, sessionDir: ctx.sessionDir, root: ended.carry.root, exclusions: ended.carry.exclusions, protect: ended.carry.protect, from: ctx.sessionId, reason: ctx.reason });
  return { ok: r.ok, carried: r.ok, unapproved: ended.unapproved };
}

/**
 * Activate a session that replaced a pairing session as closed and carried: no card, no change
 * set, host writes refused until pair_start, ended by a typed stop. ADAPTER MACHINERY ONLY.
 * @param {{ sessionId: string, sessionDir: string, root: string, exclusions?: string[], protect?: string[], from?: string | null, reason?: string }} ctx
 */
export function carryInto(ctx) {
  const dir = ctx.sessionDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(dir);
  const base = dirname(stateDir);
  const protect = [...new Set([base, PLUGIN_ROOT, ...(ctx.protect ?? [])])];
  const exclusions = Array.isArray(ctx.exclusions) ? ctx.exclusions : [...DEFAULT_EXCLUSIONS];
  return withLock(dir, () => {
    const state = loadState(dir);
    const out = carryClosed(state, {
      sessionId: ctx.sessionId, root: ctx.root, stateDir, tempPaths: defaultTempPaths(), protect, exclusions,
      from: ctx.from ?? null, reason: ctx.reason ?? "clear",
    }, makeIo({ realpath: realpathSync }));
    if (out.ok) {
      saveState(dir, out.state);
      markActivated(dir, { root: out.state.root, stateDir });
    }
    appendJournal(dir, out.journal);
    return { ok: out.ok, reason: out.reason };
  });
}

// ─── /clear carry marker (Claude Code) ──────────────────────────────────────────────────

function carryPath(base, root) {
  return join(base, CARRY_DIR, `${createHash("sha256").update(root).digest("hex").slice(0, 32)}.json`);
}

/**
 * Leave a single-use marker saying pairing was active in `root` when a session cleared. Keyed
 * by the canonical worktree root; a later marker for the same root replaces it.
 * @param {string} base  the state base
 * @param {{ root: string, from: string, exclusions?: string[], protect?: string[] }} info
 */
export function writeCarryMarker(base, info) {
  const path = carryPath(base, info.root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ root: info.root, from: info.from, exclusions: info.exclusions ?? null, protect: info.protect ?? [], at: Date.now() });
  withLock(dirname(path), () => {
    // A temp name, then rename, so a reader never sees half a marker.
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  });
}

/**
 * Take (read and delete) the carry marker for `root`, or null. A marker that is expired, for a
 * different root, or unreadable is deleted when found and never used.
 * @param {string} base
 * @param {string} root  canonical worktree root of the new session
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 */
export function takeCarryMarker(base, root, opts = {}) {
  const path = carryPath(base, root);
  if (!existsSync(path)) return null;
  return withLock(dirname(path), () => {
    let m;
    try { m = JSON.parse(readFileSync(path, "utf8")); } catch { m = null; }
    rmSync(path, { force: true });
    if (!m || typeof m !== "object" || m.root !== root || typeof m.at !== "number") return null;
    const age = (opts.now ?? Date.now()) - m.at;
    if (!(age >= 0 && age <= (opts.maxAgeMs ?? CARRY_MAX_AGE_MS))) return null;
    return m;
  });
}

// ─── executeVerb ────────────────────────────────────────────────────────────────────────

/**
 * Run one pair_* tool. Every check happens here, on the arguments this function received.
 * There is no stop verb: only the user ends pairing, by typing the stop phrase.
 * @param {string} name  pair_start | pair_note | pair_propose | pair_begin | pair_done | pair_write | pair_edit | pair_run
 * @param {Record<string, unknown>} args
 * @param {{ sessionId: string, sessionDir: string, root?: string, cwd?: string, signal?: AbortSignal,
 *   runId?: string, timeoutMs?: number, maxTimeoutMs?: number, protect?: string[] }} ctx
 *   `maxTimeoutMs` lets a host keep pair_run below its own limits (Claude Code moves a tool call
 *   that runs past a threshold to the background).
 * @returns {Promise<{ ok: boolean, text: string, result?: object }>}
 */
export async function executeVerb(name, args, ctx) {
  try {
    if (!ctx?.sessionDir) return fail(name, "no session directory");
    args = args && typeof args === "object" ? args : {};
    switch (name) {
      case "pair_start": return pairStartVerb(args, ctx);
      case "pair_note": return simple(name, ctx, (s, io) => pairNote(s, { text: args.text, roadmap: args.roadmap, earlierRoadmap: args.earlierRoadmap }, io), noteText);
      case "pair_propose": return simple(name, ctx, (s, io) => pairPropose(s, cardArgs(args), io), (r) => `Card ${r.card.id} recorded. Show it to your partner and wait for their reply.\n${JSON.stringify(r.card, null, 2)}`);
      case "pair_begin": return pairBeginVerb(args, ctx);
      case "pair_done": return pairDoneVerb(args, ctx);
      case "pair_write": return writeVerb("pair_write", args, ctx);
      case "pair_edit": return writeVerb("pair_edit", args, ctx);
      case "pair_run": return await runVerb(args, ctx);
      default: return fail(name, `unknown pairing verb ${name}`);
    }
  } catch (err) {
    return fail(name, `adapter error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fail(name, reason) {
  return { ok: false, text: `${name} refused: ${reason}` };
}

function requireActive(ctx, name) {
  return activated(ctx.sessionDir) ? null : fail(name, "pairing is not active; call pair_start first");
}

function simple(name, ctx, step, describe) {
  const inactive = requireActive(ctx, name);
  if (inactive) return inactive;
  const r = withSession(ctx.sessionDir, {}, (s) => step(s, ioFor(ctx.sessionDir, s)));
  return r.ok ? { ok: true, text: describe(r), result: r } : fail(name, r.reason);
}

function cardArgs(a) {
  const pick = {};
  for (const k of ["boundary", "whyNow", "decision", "currentCode", "effect", "checks", "openPoints"]) if (a[k] !== undefined) pick[k] = a[k];
  return pick;
}

function roadmapLines(items) {
  return items.map((it) => `  [${it.status}] ${it.id}: ${it.title}${it.note ? ` (${it.note})` : ""}`).join("\n");
}

function noteText(r) {
  if (r.declined) return "Started fresh. The earlier roadmap stays in its own journal and is not offered again.";
  if (!r.roadmapOpen) return "Noted in the pairing journal.";
  const open = r.roadmapOpen;
  return open.length
    ? `Roadmap recorded (${r.state.roadmap.length} items). Still open or not ready:\n${roadmapLines(open)}`
    : `Roadmap recorded (${r.state.roadmap.length} items). Nothing is left open or not ready.`;
}

/** How many of a worktree's journals, newest first, the pair_start roadmap offer reads at most. */
export const ROADMAP_WALK_LIMIT = 20;

function readJournal(dir) {
  const entries = [];
  let lines;
  try { lines = readFileSync(join(dir, "journal.jsonl"), "utf8").split("\n"); } catch { return entries; }
  for (const line of lines) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return entries;
}

/**
 * The earlier roadmap pair_start offers, or null. Walks the journals of every session
 * activated for the same canonical worktree root under the state base, newest journal first
 * and at most ROADMAP_WALK_LIMIT of them, past sessions that recorded no roadmap. It stops at
 * the first journal that recorded a roadmap or a start-fresh decline; the core (pairStart)
 * offers that roadmap only when it still has items open or not ready. Read-only: no journal is
 * modified.
 * @param {string} base
 * @param {string} root
 * @returns {{ fromSession: string, roadmap: object[] } | null}
 */
export function roadmapOffer(base, root) {
  let names;
  try { names = readdirSync(base); } catch { return null; }
  const sessions = [];
  for (const name of names) {
    const dir = join(base, name);
    let marker;
    try { marker = JSON.parse(readFileSync(join(dir, "activated"), "utf8")); } catch { continue; }
    if (!marker || marker.root !== root) continue;
    try { sessions.push({ name, dir, mtime: statSync(join(dir, "journal.jsonl")).mtimeMs }); } catch { /* no journal yet */ }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  for (const s of sessions.slice(0, ROADMAP_WALK_LIMIT)) {
    const record = roadmapRecord(readJournal(s.dir));
    if (!record) continue;
    return record.roadmap ? { fromSession: s.name, roadmap: record.roadmap } : null;
  }
  return null;
}

function pairStartVerb(args, ctx) {
  const problem = sandboxProblem();
  if (problem) return fail("pair_start", `${problem}; the gate cannot fence pair_run here, so pairing stays conversation-only`);
  const dir = ctx.sessionDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(dir);
  const base = dirname(stateDir);
  const root = realpathSync(ctx.root ?? findRoot(ctx.cwd ?? process.cwd()));
  if (base === root || base.startsWith(`${root}/`)) return fail("pair_start", "the pairing state directory lies inside the worktree; set PAIRED_CODING_STATE_DIR outside it");
  const extra = Array.isArray(args.exclusions) ? args.exclusions : [];
  const exclusions = [...new Set([...DEFAULT_EXCLUSIONS, ...extra])];
  const protect = [...new Set([base, PLUGIN_ROOT, ...(ctx.protect ?? [])])];
  const r = withLock(dir, () => {
    const state = loadState(dir);
    const io = makeIo({ root, exclusions });
    const found = roadmapOffer(base, root);
    const roadmapOfferArg = found ? { from: found.fromSession, roadmap: found.roadmap } : undefined;
    const out = pairStart(state, { sessionId: ctx.sessionId, root, stateDir, tempPaths: defaultTempPaths(), protect, exclusions, roadmapOffer: roadmapOfferArg, cardSeq: lastCardSeq(readJournal(dir)) }, io);
    if (out.ok) {
      saveState(dir, out.state);
      markActivated(dir, { root: out.state.root, stateDir });
    }
    appendJournal(dir, out.journal);
    return out;
  });
  if (!r.ok) return fail("pair_start", r.reason);
  const offer = r.state.roadmapOffer;
  const parts = [`Pairing started. Worktree ${r.state.root}. Host write, edit, shell and sub-agent tools are refused from now on; write with pair_write or pair_edit inside an agreed change set and run commands with pair_run. Snapshot exclusions: ${exclusions.join(", ")}. Your partner ends pairing by typing pair stop as a whole message.`];
  if (offer) {
    parts.push(`An earlier session in this worktree left roadmap items open or not ready. Show them to your partner and ask whether to pick that roadmap up or start fresh; nothing reopens unless they agree. Record their answer with pair_note's earlierRoadmap field: "pick-up" carries the whole roadmap into this session, "start-fresh" sets it aside so it is not offered again.\n${roadmapLines(openRoadmapItems(offer.roadmap))}`);
  }
  const roadmapOfferResult = offer ? { fromSession: offer.from, items: openRoadmapItems(offer.roadmap) } : null;
  return { ok: true, text: parts.join("\n\n"), result: { ...r, roadmapOffer: roadmapOfferResult } };
}

function pairBeginVerb(args, ctx) {
  const inactive = requireActive(ctx, "pair_begin");
  if (inactive) return inactive;
  const dir = ctx.sessionDir;
  const r = withSession(dir, {}, (s) => {
    const out = pairBegin(s, { cardId: args.cardId, quote: args.quote }, ioFor(dir, s));
    if (out.ok) keepBeforeCopies(dir, out.state);
    return out;
  });
  if (!r.ok) return fail("pair_begin", r.reason);
  const cs = r.state.changeSet;
  return { ok: true, text: `Change set ${cs.cardId} is open. Boundary: ${cs.boundary.join(", ")}. Write only there with pair_write or pair_edit; run checks with pair_run; finish with pair_done.`, result: r };
}

/** Copies of the boundary files as they were at pair_begin, for pair_done's machine-made diff. */
function keepBeforeCopies(dir, state) {
  const cs = state.changeSet;
  const into = join(dir, "changesets", cs.cardId, "before");
  for (const rel of Object.keys(state.baseline ?? {})) {
    if (!boundaryMatches(cs.boundary, rel)) continue;
    const src = join(state.root, rel);
    if (!lstatSync(src).isFile()) continue;
    mkdirSync(dirname(join(into, rel)), { recursive: true, mode: 0o700 });
    copyFileSync(src, join(into, rel));
  }
}

function pairDoneVerb(args, ctx) {
  const inactive = requireActive(ctx, "pair_done");
  if (inactive) return inactive;
  const dir = ctx.sessionDir;
  const r = withSession(dir, {}, (s) => pairDone(s, { cardId: args.cardId }, ioFor(dir, s)));
  if (!r.ok) return fail("pair_done", r.reason);
  const diff = machineDiff(dir, r.state.root, String(args.cardId), r.changed ?? []);
  const parts = [`Change set ${args.cardId} closed.`];
  parts.push(diff ? `Diff of the boundary since pair_begin (machine-produced):\n${diff}` : "No change inside the boundary.");
  if (r.halted) parts.push(`STOPPED: unapproved write outside the boundary: ${r.unapproved.map((u) => `${u.change} ${u.path}`).join(", ")}. Show this to your partner; only your partner ends the session, by typing pair stop.`);
  const roadmapOpen = r.roadmapOpen ?? [];
  if (roadmapOpen.length) parts.push(`Roadmap items still open or not ready:\n${roadmapLines(roadmapOpen)}`);
  return { ok: true, text: parts.join("\n\n"), result: { changed: r.changed, unapproved: r.unapproved, halted: r.halted, diff, roadmapOpen } };
}

function machineDiff(dir, root, cardId, changed) {
  const before = join(dir, "changesets", cardId, "before");
  const out = [];
  for (const c of changed) {
    const a = join(before, c.path);
    const b = join(root, c.path);
    const res = spawnSync("/usr/bin/diff", ["-u", "--label", `a/${c.path}`, "--label", `b/${c.path}`, existsSync(a) ? a : "/dev/null", existsSync(b) ? b : "/dev/null"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    out.push(res.stdout || `${c.change} ${c.path} (not a text diff)`);
  }
  return out.join("");
}

function writeVerb(name, args, ctx) {
  const inactive = requireActive(ctx, name);
  if (inactive) return inactive;
  const dir = ctx.sessionDir;
  if (name === "pair_write" && typeof args.content !== "string") return fail(name, "content is not a string");
  if (name === "pair_edit" && (typeof args.oldString !== "string" || typeof args.newString !== "string" || args.oldString === "")) {
    return fail(name, "oldString and newString are required strings and oldString is not empty");
  }
  const problem = sandboxProblem();
  if (problem) return fail(name, problem);
  return withLock(dir, () => {
    const s = loadState(dir);
    const c = checkWrite(s, { path: args.path, toolName: name }, ioFor(dir, s));
    if (!c.ok) {
      appendJournal(dir, c.journal);
      return fail(name, c.reason);
    }
    let text;
    if (name === "pair_write") {
      text = args.content;
    } else {
      let current;
      try { current = readFileSync(c.absPath, "utf8"); } catch (err) { appendJournal(dir, [{ type: "refusal", verb: name, path: String(args.path), reason: "file unreadable" }]); return fail(name, `cannot read ${args.path}: ${err.code ?? err.message}`); }
      const count = current.split(args.oldString).length - 1;
      if (count === 0) return fail(name, "oldString does not occur in the file");
      if (count > 1 && args.replaceAll !== true) return fail(name, `oldString occurs ${count} times; pass replaceAll or a longer oldString`);
      text = args.replaceAll === true ? current.split(args.oldString).join(args.newString) : current.replace(args.oldString, () => args.newString);
    }
    // The write itself runs under the open-phase Seatbelt profile, so the kernel checks the
    // resolved target: a symlink swapped in after checkWrite cannot carry it out of the boundary.
    // It is staged in a new file beside the target and renamed over it, so a hard link at the
    // target is replaced rather than written through to a file outside the boundary.
    const tempPath = join(dirname(c.absPath), `.pair-write-${randomBytes(8).toString("hex")}.tmp`);
    const w = writeSandboxed({ profile: pairWriteProfile(s, tempPath), path: c.absPath, tempPath, content: text });
    if (!w.ok) {
      appendJournal(dir, [{ type: "refusal", verb: name, path: String(args.path), reason: `the sandboxed write failed: ${w.error}`, at: new Date().toISOString() }]);
      return fail(name, `the sandboxed write failed: ${w.error}`);
    }
    appendJournal(dir, c.journal);
    return { ok: true, text: `${name === "pair_write" ? "Wrote" : "Edited"} ${args.path}.` };
  });
}

async function runVerb(args, ctx) {
  const inactive = requireActive(ctx, "pair_run");
  if (inactive) return inactive;
  const problem = sandboxProblem();
  if (problem) return fail("pair_run", problem);
  if (typeof args.command !== "string" || args.command.trim() === "") return fail("pair_run", "command is empty");
  const dir = ctx.sessionDir;
  const runId = ctx.runId ?? `run-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const asked = Number(args.timeoutSeconds) > 0 ? Number(args.timeoutSeconds) * 1000 : ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(asked, ctx.maxTimeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const start = withSession(dir, {}, (s) => runStart(s, { runId }, ioFor(dir, s)));
  if (!start.ok) return fail("pair_run", start.reason);
  const res = await runSandboxed({
    profile: start.profile,
    command: args.command,
    cwd: start.state.root,
    timeoutMs,
    signal: ctx.signal,
    onSpawn: (pgid) => recordRun(dir, runId, pgid),
  });
  withSession(dir, {}, (s) => {
    const out = runEnd(s, { runId, exitCode: res.exitCode }, makeIo({}));
    out.journal = out.journal.map((e) => ({ ...e, timedOut: res.timedOut, aborted: res.aborted, signal: res.signal }));
    return out;
  });
  const head = res.timedOut ? `timed out after ${timeoutMs / 1000}s; its process group was killed`
    : res.aborted ? "aborted; its process group was killed"
    : res.error ? `could not run: ${res.error}`
    : `exit ${res.exitCode}${res.signal ? ` (signal ${res.signal})` : ""}`;
  const text = [`pair_run ${head} (phase ${start.state.phase}).`, res.stdout && `stdout:\n${res.stdout}`, res.stderr && `stderr:\n${res.stderr}`].filter(Boolean).join("\n");
  return { ok: !res.timedOut && !res.aborted && !res.error && res.exitCode === 0, text, result: { exitCode: res.exitCode, timedOut: res.timedOut, aborted: res.aborted, runId } };
}

