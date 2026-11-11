// lib/mid-session.mjs — what the mid-session hook (hooks/mid-session.mjs, 0.4.0) tells the agent
// while a session runs, and the per-session latch that keeps it to once per episode.
//
// It reads two files and spawns nothing: the timer's `<state>/state.json` (the launchd tick
// probes ctx every 5 min and keeps the episode there; lib/state.mjs) and the session's latch,
// `<state>/sessions/<session id>.json` = `{ down, toldAt, stale }`: when this session was last
// told ctx is down (`toldAt`, null once told it is back), the timer's `downSince` for that outage
// (null when SessionStart told it from its own probe before the timer declared one), and the
// tick stamp it was told was stale. A per-prompt hook that ran `ctx daemon status` would add its
// 0.15 s (or a hung ctx's whole bound) to every prompt; this costs one node start and two small
// file reads.
//
// decide(state, latch, now) → { say, latch }, `say` one of:
//   "stale"      the tick stamp (or, never ticked, the first SessionStart's) is older than
//                STALE_AFTER_MS (15 min) or three intervals, whichever is longer: the timer has
//                stopped, so the state cannot say whether ctx is up. Once per stamp. While stale,
//                nothing else is said: a down or a recovery read from it is not current news.
//   "down"       `episode: "down"` (two failing ticks in a row; one is a blip and says nothing)
//                of kind daemon (which includes `not healed: upgrade state unknown`) or upgrade
//                (stuck), to a session not told of an outage, or told of a different `downSince`.
//                A semantic-only episode says nothing: the daemon is up and ctx search answers
//                lexically (SessionStart is the same). A session SessionStart told from its own
//                probe adopts the timer's `downSince` silently: it is the same outage.
//   "recovered"  this session was told of an outage, and the timer's latest probe is later than
//                that telling and passed, or failed only on the semantic index (the daemon is
//                up): one line. Nothing else is a recovery: a state that is missing, unreadable,
//                out of shape or reset (all read as EMPTY, with no probe), a pass older than the
//                telling, or a failing strike says nothing and keeps the latch.
//   null         nothing to say: healthy, a strike, semantic, or already told.
//
// The claim is atomic: when there is something to say or record, the latch is re-read, decided
// and written under `<latch>.lock` (state.mjs withStateLock, LATCH_LOCK_WAIT_MS), the lock
// SessionStart's noteTold takes too, so two hooks of one session cannot both say it. A lock held
// by a live peer past the wait is that peer's notice: this hook says nothing. A latch (or its
// lock) that cannot be written still lets the answer out, with a note that it may repeat: an
// agent told twice beats an agent never told. No session id: nothing is said, since nothing could
// latch it. The healthy path takes no lock and writes nothing.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INTERVAL_S, readState, stateDir, statePath, withStateLock } from "./state.mjs";
import { shellQuote } from "./launchd.mjs";

/** The least age of the tick stamp at which the state is not trusted. */
export const STALE_AFTER_MS = 15 * 60 * 1000;
/** How long a hook waits for another hook of the same session holding its latch (each holds it for two small file operations). */
export const LATCH_LOCK_WAIT_MS = 200;
/** The events the hook answers, each with its own hookSpecificOutput.hookEventName. */
export const EVENTS = Object.freeze(["UserPromptSubmit", "PostToolUseFailure"]);
/** The CLI the `repair` and `install` commands name. */
export const CLI_PATH = fileURLToPath(new URL("../scripts/ctx-watch.mjs", import.meta.url));
const REASON_MAX = 240;
const MAX_DATE_MS = 8.64e15;
const NO_LATCH = Object.freeze({ down: null, toldAt: null, stale: null });

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const validMs = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_DATE_MS;
const iso = (ms) => new Date(ms).toISOString();
const cut = (s) => (String(s).length > REASON_MAX ? `${String(s).slice(0, REASON_MAX - 1)}…` : String(s));
const same = (a, b) => a.down === b.down && a.toldAt === b.toldAt && a.stale === b.stale;

/** `<dir>/sessions/<session id>.json`. */
export const latchPath = (dir, sessionId) => join(dir, "sessions", `${safeId(sessionId)}.json`);

/** The latch at `path`; NO_LATCH when missing or out of shape. A latch from before `toldAt` with a `down` was told at that `down`. */
export function readLatch(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const down = validMs(j?.down) ? j.down : null;
    const toldAt = validMs(j?.toldAt) ? j.toldAt : "toldAt" in (j ?? {}) ? null : down;
    return { down, toldAt, stale: validMs(j?.stale) ? j.stale : null };
  } catch {
    return { ...NO_LATCH };
  }
}

/** Write atomically; null, or the error. */
export function writeLatch(path, latch) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ down: latch.down, toldAt: latch.toldAt, stale: latch.stale })}\n`);
    renameSync(tmp, path);
    return null;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing was left */
    }
    return err;
  }
}

/**
 * Run `fn()` holding `<latch>.lock`: `{ value }`; `{ busy: true }` when a live holder kept it past
 * LATCH_LOCK_WAIT_MS; or, when the lock itself cannot be made (a filesystem error), `fn()` run
 * without it and `{ value, unlocked: error }`.
 */
function withLatchLock(path, fn) {
  const r = withStateLock(dirname(path), fn, { waitMs: LATCH_LOCK_WAIT_MS, lock: `${path}.lock` });
  if (r.ok) return { value: r.value };
  if (r.error.cause) return { value: fn(), unlocked: r.error };
  return { busy: true };
}

/**
 * Record that `sessionId` was told at `toldAt` that ctx is down (SessionStart's telling), with the
 * timer's `downSince` when the timer had declared that outage, else null. Null, or the error.
 */
export function noteTold(dir, sessionId, { down = null, toldAt }) {
  const path = latchPath(dir, sessionId);
  const r = withLatchLock(path, () => writeLatch(path, { ...readLatch(path), down, toldAt }));
  return r.busy ? new Error(`${path}.lock is held by another hook`) : r.value;
}

/** The stamp the state is stale since, or null: the tick's, else the first SessionStart's, older than the bound. */
export function staleSince(state, now) {
  const since = state.lastTickAt ?? state.firstSeenAt ?? null;
  if (since === null) return null;
  const bound = Math.max(STALE_AFTER_MS, 3 * (state.intervalS ?? DEFAULT_INTERVAL_S) * 1000);
  return now - since > bound ? since : null;
}

const telling = (state) => state.episode === "down" && state.episodeKind !== "semantic" && state.downSince !== null;

/** Whether the timer's latest probe, taken after `toldAt`, shows the daemon up: passed, or failed only on the semantic index. */
export function recoveredSince(state, toldAt) {
  const p = state.lastProbe;
  if (!p || state.lastTickAt === null || p.at <= toldAt || telling(state)) return false;
  return p.ok || state.episodeKind === "semantic";
}

/** What to say now, and the latch after saying it. */
export function decide(state, latch, now) {
  const stale = staleSince(state, now);
  if (stale !== null) return latch.stale === stale ? { say: null, latch } : { say: "stale", latch: { ...latch, stale } };
  const told = latch.toldAt !== null;
  if (telling(state)) {
    if (!told || (latch.down !== null && latch.down !== state.downSince)) return { say: "down", latch: { ...latch, down: state.downSince, toldAt: now } };
    return latch.down === null ? { say: null, latch: { ...latch, down: state.downSince } } : { say: null, latch };
  }
  if (told && recoveredSince(state, latch.toldAt)) return { say: "recovered", latch: { ...latch, down: null, toldAt: null } };
  return { say: null, latch };
}

const lastProbeText = (p) => (p ? `its last probe (${iso(p.at)}) ${p.ok ? "passed" : `failed: ${cut(p.reason ?? "no reason recorded")}`}` : "it has no probe on record");

/** The agent's text for `say`. */
export function message(say, state, now, cliPath = CLI_PATH) {
  const cli = shellQuote(cliPath);
  if (say === "stale") {
    const since = staleSince(state, now);
    const what = state.lastTickAt === null ? `its timer has never run (first seen ${iso(since)})` : `its timer has not run since ${iso(since)}`;
    return `ctx-watch: ${what}, over ${Math.round((now - since) / 60_000)} min, so it cannot tell whether ctx is up now (${lastProbeText(state.lastProbe)}); check with \`ctx daemon status --format json\`, and ask the person to reinstall the timer from a Terminal: \`node ${cli} install\` and the launchctl line it prints.`;
  }
  if (say === "recovered") {
    const p = state.lastProbe;
    if (!p.ok) return `ctx-watch: the ctx daemon is back up (the ctx-watch timer's probe at ${iso(p.at)}); its semantic index is not ready yet (${cut(p.reason ?? "no reason recorded")}), so ctx search answers lexically until it is.`;
    return `ctx-watch: ctx is back up (the ctx-watch timer's probe passed at ${iso(p.at)}); ctx search and history work again.`;
  }
  const reason = cut(state.lastProbe?.reason ?? "no reason recorded");
  const at = state.lastProbe ? ` at ${iso(state.lastProbe.at)}` : "";
  const what =
    state.episodeKind === "upgrade"
      ? `ctx-watch: ctx's upgrade has been stuck since ${iso(state.downSince)} (the ctx-watch timer's probe${at}: ${reason}); no ctx daemon can start, so ctx search and history are down until it is released.`
      : `ctx-watch: the ctx daemon has been down since ${iso(state.downSince)} (the ctx-watch timer's probe${at}: ${reason}); ctx search and history calls fail or return stale results until it is repaired.`;
  return [what, `Repair: \`/ctx-watch:repair\` (or \`node ${cli} repair\`: exit 0 repaired, 3 refused with nothing changed, its last line says why; it refuses during a live ctx upgrade). ctx-watch says once more here when ctx is back.`].join("\n");
}

/** Whether a PostToolUseFailure input is a failed ctx call (the hooks.json `if` filter is best-effort). */
export function ctxCall(input) {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  if (/^mcp__ctx_/.test(tool)) return true;
  return tool === "Bash" && /(^|[\s;&|(`])ctx\s/.test(String(input.tool_input?.command ?? ""));
}

/**
 * The hook's answer for `input`: `{ hookSpecificOutput: { hookEventName, additionalContext } }`
 * or null. Reads `<state>/state.json` and the session's latch only.
 */
export function midSession(input, { env = process.env, now = Date.now, cliPath = CLI_PATH } = {}) {
  const event = input.hook_event_name;
  if (!EVENTS.includes(event)) return null;
  if (event === "PostToolUseFailure" && !ctxCall(input)) return null;
  const id = typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (!id) return null;
  const dir = stateDir(env);
  // Quietly: a state file out of shape is SessionStart's and the tick's to report, not every prompt's.
  const state = readState(statePath(env, dir), { log: () => {} });
  const at = now();
  const path = latchPath(dir, id);
  // Unlocked first: the usual prompt has nothing to say or record, and takes no lock.
  const seen = readLatch(path);
  const first = decide(state, seen, at);
  if (!first.say && same(first.latch, seen)) return null;
  const claim = withLatchLock(path, () => {
    const cur = readLatch(path);
    const { say, latch } = decide(state, cur, at);
    const err = same(latch, cur) ? null : writeLatch(path, latch);
    return { say, err };
  });
  if (claim.busy) return null;
  const { say, err } = claim.value;
  if (!say) return null;
  const text = message(say, state, at, cliPath);
  const failed = err ?? claim.unlocked;
  const note = failed ? `\n(ctx-watch could not record that it said this, so it may repeat: ${failed.message})` : "";
  return { hookSpecificOutput: { hookEventName: event, additionalContext: `${text}${note}` } };
}
