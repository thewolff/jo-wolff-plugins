// lib/state.mjs — the episode state the launchd tick keeps between runs, and the SessionStart
// hook reads for its dead-man's line.
//
// `${XDG_STATE_HOME:-~/.local/state}/ctx-watch/state.json`:
//
//   episode          "up" | "strike" | "down"
//   strikes          failing ticks in a row, of any kind (0 when up)
//   episodeKind      "daemon" | "semantic" | null: the kind of the last failing tick (null when up).
//                    "semantic" is a failure `ctx index mode auto` cannot touch (`healable: false`:
//                    the daemon passed every check above the semantic rows); anything else is "daemon"
//   kindStrikes      failing ticks of episodeKind in a row (0 when up)
//   passStreak       passing ticks in a row (0 while failing)
//   popupShown       { daemon, semantic }: one latch per failure kind, true once that kind's popup
//                    was delivered (osascript exited 0, or the person dismissed it). The daemon
//                    latch re-arms on any tick where the daemon is up (a pass, or a semantic
//                    failure); the semantic latch only after STRIKES_TO_DOWN passing ticks in a row,
//                    so a semantic status that flips ready → not ready → ready does not pop each
//                    time. A file from before 0.2.0 has one boolean: it is read as the daemon latch
//   popupPending     { token, since, kind } from the moment a tick claims a popup (written before
//                    the supervisor starts) until it is settled: not delivered yet, and no second
//                    dialog of either kind is asked for meanwhile (`kind` missing: "daemon"). It
//                    is dropped when its kind's latch re-arms
//   popupFailedAt    ms of the last popup that could not be delivered this episode, or null
//   popupFailReason  why, or null
//   downSince        ms of the tick that opened the episode's down, or null
//   lastTickAt       ms of the last `tick` (the dead-man's stamp)
//   intervalS        the StartInterval the last `install` wrote, so the hook knows 2× of it
//   lastProbe        { at, ok, reason, healed } from the last tick
//   lastPopupAt      ms of the last delivered popup
//   firstSeenAt      ms the SessionStart hook first ran: a timer that never ticked is overdue
//                    measured from here (ledger's digest dead-man's switch does the same)
//
// step(state, result, now) → { state, popup }: a failing probe strikes once, then goes down on
// the second failing tick in a row; a kind's popup is asked for once its kind has failed
// STRIKES_TO_DOWN ticks in a row and its latch is open, so a daemon death after a semantic popup
// gets its own popup. A passing probe closes the episode and re-arms as above. `popup: true` is a
// request for the episodeKind's popup: the tick first records the claim
// (`popupPending` under a fresh token) and only once that write has landed starts the dialog,
// then calls popupDelivered(state, outcome, now), which latches the claim's kind only on a confirmed
// delivery, keeps a popup still running after the grace pending, and releases the claim on a
// failure, so a popup that could not be shown is tried again on the next failing tick. Each
// tick first calls popupSettled(state, readOutcome(<state>/popups/<token>.json), now) for the
// pending token: its supervisor's outcome latches a delivery or reopens the episode on a late
// failure; a pending popup with no outcome after PENDING_STALE_MS reopens it too (also the
// recovery for a tick that died between its claim and the dialog). Never throws.
//
// Every read-modify-write of state.json (the tick's claim and its result, `install`'s interval,
// the hook's first-seen stamp) holds `<state>/state.lock` (withStateLock): a file created with
// O_EXCL holding `<pid> <nonce>`, so two ticks cannot both read "no popup yet" and both claim
// it. A lock whose pid is not running, or older than LOCK_STALE_MS, was left by a holder that
// died and is taken over. Each supervisor writes only its own token's outcome file, so neither
// file has two writers.
//
// readState(path) is the file, validated field by field (the enums, booleans, bounded counters
// and whole-epoch-ms stamps above; unknown fields dropped), or EMPTY when the file is missing,
// unreadable, not an object, or has any field out of shape: a state file that says
// `strikes: -100` or `popupShown: "yes"` would otherwise hold the popup off for the whole
// outage, so it is treated as absent and named in one errors.log line beside it.

import * as nodeFs from "node:fs";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GIVE_UP_SECS, TOKEN, delivered, describeExit } from "./popup.mjs";

export const PLUGIN = "ctx-watch";
export const DEFAULT_INTERVAL_S = 300;
export const STRIKES_TO_DOWN = 2;
/** More failing ticks in a row than a year of 30 s ticks: anything beyond is not a count. */
export const MAX_STRIKES = 1_100_000;
/**
 * The StartInterval range, in seconds: `install` refuses anything outside it before writing the
 * plist, and readState treats a state file holding anything outside it as out of shape. One
 * constant so the producer and the reader cannot disagree (a week is the most a dead-man's switch
 * at twice the interval is still worth having).
 */
export const INTERVAL_BOUNDS = Object.freeze({ min: 30, max: 86_400 * 7 });
const MAX_DATE_MS = 8.64e15;
/** How long a pending popup may go without an outcome: its give-up plus ten minutes (a supervisor killed with its login session never writes one). */
export const PENDING_STALE_MS = (GIVE_UP_SECS + 600) * 1000;
/** A state lock older than this is a holder that hung or died (every holder keeps it for a few file operations). */
export const LOCK_STALE_MS = 30_000;
/** How long a writer waits for another's lock before it gives up and says so. */
export const LOCK_WAIT_MS = 2_000;

/** `${XDG_STATE_HOME:-~/.local/state}/ctx-watch` (the hook runner's rule, repeated so the CLI shares it). */
export function stateDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), PLUGIN);
}

/** `<dir>/state.json`; `dir` defaults to stateDir(env) (the timer passes the directory it was installed with). */
export function statePath(env = process.env, dir = stateDir(env)) {
  return join(dir, "state.json");
}

/** `<dir>/state.lock`: held by every read-modify-write of state.json. */
export function lockPath(dir) {
  return join(dir, "state.lock");
}

/** Whether `pid` names a running process (EPERM: running, someone else's). */
export function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The pause between lock attempts doubles from the first to the cap (never past the deadline). */
const BACKOFF_MS = Object.freeze({ first: 5, cap: 50 });

/** ENOENT on the lock's read or rename: its holder released it or another writer moved it meanwhile. Any other code persists. */
const vanished = (err) => err?.code === "ENOENT";

/**
 * One attempt: `{ held }` (our content), `{ busy }` (the holder's pid), `{ again }` (the lock
 * changed under us), or `{ error }` (a filesystem error that another attempt would only repeat).
 */
function tryLock(path, staleMs, fs) {
  const mine = `${process.pid} ${randomUUID()}\n`;
  const create = () => {
    try {
      fs.writeFileSync(path, mine, { flag: "wx" });
      return { held: mine };
    } catch (err) {
      return err.code === "EEXIST" ? null : { error: err };
    }
  };
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    return { error: err };
  }
  const first = create();
  if (first) return first;
  let text;
  let age;
  try {
    text = fs.readFileSync(path, "utf8");
    age = Date.now() - fs.statSync(path).mtimeMs;
  } catch (err) {
    return vanished(err) ? { again: true } : { error: err };
  }
  const pid = /^(\d+) /.exec(text)?.[1];
  // An empty or half-written lock is a holder between creating it and writing its pid: busy while fresh.
  if (age <= staleMs && (pid === undefined || running(Number(pid)))) return { busy: pid ?? "unknown" };
  // Stale: set it aside under a name only this process uses, and drop it only if it is still the
  // lock judged stale; a fresh lock some other process made meanwhile is put back.
  const aside = `${path}.${process.pid}.stale`;
  try {
    fs.renameSync(path, aside);
  } catch (err) {
    return vanished(err) ? { again: true } : { error: err };
  }
  let moved = null;
  try {
    moved = fs.readFileSync(aside, "utf8");
  } catch {
    /* gone: nothing to put back */
  }
  if (moved !== null && moved !== text) {
    try {
      fs.linkSync(aside, path);
    } catch {
      /* a third writer already holds the name */
    }
  }
  try {
    fs.rmSync(aside, { force: true });
  } catch (err) {
    return { error: err };
  }
  // Take the name now it is free, in this same attempt: a stale lock is taken over at once.
  return create() ?? { again: true };
}

/**
 * Run `fn()` holding `<dir>/state.lock`; `{ ok: true, value }`, or `{ ok: false, error }` and
 * then `fn` never runs: `could not lock <path>: <error>` at once for a filesystem error another
 * attempt would repeat (EACCES, EROFS, ENOSPC, …); `<path> is held by pid <n>` when a live holder
 * keeps it past `waitMs`; `could not lock <path>: still contended after <waitMs> ms` when it kept
 * changing under us that long. One attempt is always made; every later one is checked against the
 * same monotonic deadline first, after a backoff of 5 ms doubling to 50 ms. The lock is released
 * however `fn` ends (a throw propagates). Synchronous: every holder keeps it for a few file
 * operations. `fs` is injectable for the fault tests.
 */
export function withStateLock(dir, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, fs = nodeFs } = {}) {
  const path = lockPath(dir);
  const until = performance.now() + waitMs;
  let pause = BACKOFF_MS.first;
  for (;;) {
    const r = tryLock(path, staleMs, fs);
    if (r.error) return { ok: false, error: new Error(`could not lock ${path}: ${r.error.message}`, { cause: r.error }) };
    if (r.held) {
      try {
        return { ok: true, value: fn() };
      } finally {
        try {
          if (fs.readFileSync(path, "utf8") === r.held) fs.rmSync(path, { force: true });
        } catch {
          /* already gone */
        }
      }
    }
    const left = until - performance.now();
    if (left <= 0) return { ok: false, error: new Error(r.busy ? `${path} is held by pid ${r.busy}` : `could not lock ${path}: still contended after ${waitMs} ms`) };
    sleep(Math.min(pause, left));
    pause = Math.min(pause * 2, BACKOFF_MS.cap);
  }
}

/** The popup kinds, each with its own latch. */
export const FAILURE_KINDS = Object.freeze(["daemon", "semantic"]);

/** A failing check() result's kind: "semantic" for the rows the heal cannot touch (`healable: false`), else "daemon". */
export function failureKind(result) {
  return result.healable === false ? "semantic" : "daemon";
}

export const EMPTY = Object.freeze({
  episode: "up",
  strikes: 0,
  episodeKind: null,
  kindStrikes: 0,
  passStreak: 0,
  popupShown: Object.freeze({ daemon: false, semantic: false }),
  popupFailedAt: null,
  popupFailReason: null,
  popupPending: null,
  downSince: null,
  lastTickAt: null,
  intervalS: null,
  lastProbe: null,
  lastPopupAt: null,
  firstSeenAt: null,
});

const validMs = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_DATE_MS;
const nullOr = (f) => (v) => v === null || f(v);
const isBool = (v) => typeof v === "boolean";
const isStr = (v) => typeof v === "string";
const isProbe = (v) => v && typeof v === "object" && !Array.isArray(v) && validMs(v.at) && isBool(v.ok) && nullOr(isStr)(v.reason ?? null) && nullOr(isStr)(v.healed ?? null);
const isKind = (v) => FAILURE_KINDS.includes(v);
const isPending = (v) => v && typeof v === "object" && !Array.isArray(v) && isStr(v.token) && TOKEN.test(v.token) && validMs(v.since) && (v.kind === undefined || isKind(v.kind));
const isLatch = (v) => isBool(v) || (v && typeof v === "object" && !Array.isArray(v) && isBool(v.daemon) && isBool(v.semantic));
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_STRIKES;

/** Each field's test and, for the message, its shape. */
const SHAPE = Object.freeze({
  episode: [(v) => v === "up" || v === "strike" || v === "down", '"up" | "strike" | "down"'],
  strikes: [isCount, `a whole number 0..${MAX_STRIKES}`],
  episodeKind: [nullOr(isKind), '"daemon" | "semantic" | null'],
  kindStrikes: [isCount, `a whole number 0..${MAX_STRIKES}`],
  passStreak: [isCount, `a whole number 0..${MAX_STRIKES}`],
  popupShown: [isLatch, "{ daemon, semantic } of true | false (or one true | false from before 0.2.0)"],
  popupFailedAt: [nullOr(validMs), "epoch ms | null"],
  popupFailReason: [nullOr(isStr), "a string | null"],
  popupPending: [nullOr(isPending), "{ token, since, kind? } | null"],
  downSince: [nullOr(validMs), "epoch ms | null"],
  lastTickAt: [nullOr(validMs), "epoch ms | null"],
  intervalS: [nullOr((v) => Number.isInteger(v) && v >= INTERVAL_BOUNDS.min && v <= INTERVAL_BOUNDS.max), `a whole number ${INTERVAL_BOUNDS.min}..${INTERVAL_BOUNDS.max} | null`],
  lastProbe: [nullOr(isProbe), "{ at, ok, reason, healed } | null"],
  lastPopupAt: [nullOr(validMs), "epoch ms | null"],
  firstSeenAt: [nullOr(validMs), "epoch ms | null"],
});

/** A field's value as the state keeps it: the pre-0.2.0 boolean latch becomes the daemon latch; a pending popup with no kind is the daemon's. */
function normalize(k, v) {
  if (k === "lastProbe" && v) return { at: v.at, ok: v.ok, reason: v.reason ?? null, healed: v.healed ?? null };
  if (k === "popupPending" && v) return { token: v.token, since: v.since, kind: v.kind ?? "daemon" };
  if (k === "popupShown") return isBool(v) ? { daemon: v, semantic: false } : { daemon: v.daemon, semantic: v.semantic };
  return v;
}

/**
 * `j` as a state object: `{ state }` with only the known fields (missing ones from EMPTY), or
 * `{ problem }` naming the first field out of shape.
 */
export function validateState(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return { problem: "not an object" };
  const state = { ...EMPTY };
  for (const [k, [test, shape]] of Object.entries(SHAPE)) {
    if (!(k in j)) continue;
    const v = j[k];
    if (!test(v)) return { problem: `${k} is ${JSON.stringify(v)?.slice(0, 80) ?? String(v)}, not ${shape}` };
    state[k] = normalize(k, v);
  }
  // A file from before 0.2.0 has no episodeKind: its strike or down was a daemon episode.
  if (!("episodeKind" in j) && state.episode !== "up") Object.assign(state, { episodeKind: "daemon", kindStrikes: state.strikes });
  return { state };
}

/** One `<iso> state.json <message>` line in errors.log beside `path`; never throws. */
function logBeside(path, message) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(join(dirname(path), "errors.log"), `${new Date().toISOString()} state.json ${String(message).replace(/\s+/g, " ").trim()}\n`);
  } catch {
    /* nowhere to log */
  }
}

/**
 * The state at `path`, or EMPTY when missing, unreadable, not an object, or with a field out of
 * shape (then one errors.log line names the field; `log` is injectable).
 */
export function readState(path, { log = logBeside } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ...EMPTY };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    log(path, `${path} is not JSON (${err.message}); treated as absent`);
    return { ...EMPTY };
  }
  const v = validateState(j);
  if (v.problem) {
    log(path, `${path} ignored: ${v.problem}; treated as absent`);
    return { ...EMPTY };
  }
  return v.state;
}

/**
 * Write atomically (temp file + rename). Returns true, or false with the error on
 * `writeState.lastError`; a temp file left by a failed write is removed.
 */
export function writeState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, path);
    return true;
  } catch (err) {
    writeState.lastError = err;
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the directory itself is unwritable; nothing was left */
    }
    return false;
  }
}

/**
 * One tick's transition. `result` is a `check()` result (`ok`, `reason`, `healed`, `healable`);
 * `now` ms. `popup: true` asks the tick to claim and show the popup of `state.episodeKind`; see
 * popupDelivered for the latch. While any popup is pending none is asked for: the dialog may
 * still be up.
 */
export function step(state, result, now) {
  const base = { ...EMPTY, ...state, lastTickAt: now, lastProbe: { at: now, ok: result.ok, reason: result.reason ?? null, healed: result.healed?.detail ?? null } };
  const shown = { ...EMPTY.popupShown, ...base.popupShown };
  // A pending popup whose kind just re-armed belongs to an episode that is over; its late outcome is ignored.
  const pendingAfter = (rearmed) => (base.popupPending && !rearmed[base.popupPending.kind ?? "daemon"] ? base.popupPending : null);
  if (result.ok) {
    const passStreak = Math.min(base.passStreak + 1, MAX_STRIKES);
    const rearmed = { daemon: true, semantic: passStreak >= STRIKES_TO_DOWN };
    const popupShown = { daemon: false, semantic: shown.semantic && !rearmed.semantic };
    return { state: { ...base, episode: "up", strikes: 0, episodeKind: null, kindStrikes: 0, passStreak, popupShown, popupPending: pendingAfter(rearmed), popupFailedAt: null, popupFailReason: null, downSince: null }, popup: false };
  }
  const kind = failureKind(result);
  // A semantic failure means the daemon is up: the daemon's latch re-arms.
  const rearmed = { daemon: kind === "semantic", semantic: false };
  const popupShown = { daemon: shown.daemon && !rearmed.daemon, semantic: shown.semantic };
  const popupPending = pendingAfter(rearmed);
  const strikes = Math.min(base.strikes + 1, MAX_STRIKES);
  const kindStrikes = base.episodeKind === kind ? Math.min(base.kindStrikes + 1, MAX_STRIKES) : 1;
  const next = { ...base, strikes, episodeKind: kind, kindStrikes, passStreak: 0, popupShown, popupPending };
  if (strikes < STRIKES_TO_DOWN) return { state: { ...next, episode: "strike" }, popup: false };
  return { state: { ...next, episode: "down", downSince: base.downSince ?? now }, popup: kindStrikes >= STRIKES_TO_DOWN && !popupShown[kind] && !popupPending };
}

const reason = (s) => String(s).slice(0, 200);

/** The kind a popup was claimed for: the pending claim's, else the episode's. */
const claimKind = (state) => state.popupPending?.kind ?? state.episodeKind ?? "daemon";
const latch = (state, kind, value) => ({ ...EMPTY.popupShown, ...state.popupShown, [kind]: value });

/**
 * Record what showPopup resolved (`{ started, pending?, token?, detail }`) on the state that
 * holds its claim: confirmed delivered → the claim kind's latch set and `lastPopupAt` stamped;
 * still running after the grace → pending under its token, latch open; not delivered → claim
 * released, `popupFailedAt` and the reason, latch open so the next failing tick tries again.
 */
export function popupDelivered(state, outcome, now) {
  const kind = claimKind(state);
  if (outcome.started && outcome.pending) return { ...state, popupShown: latch(state, kind, false), popupPending: { token: outcome.token, since: now, kind }, popupFailedAt: null, popupFailReason: null };
  if (outcome.started) return { ...state, popupShown: latch(state, kind, true), popupPending: null, lastPopupAt: now, popupFailedAt: null, popupFailReason: null };
  return { ...state, popupShown: latch(state, kind, false), popupPending: null, popupFailedAt: now, popupFailReason: reason(outcome.detail ?? "popup not shown") };
}

/**
 * Settle a pending popup from its supervisor's outcome (readOutcome of the pending token's own
 * file; null when there is none). `{ state, line }`: `line` (for the tick's output) is null when
 * nothing changed. The outcome for the pending token decides: delivered → latched, `lastPopupAt`
 * the tick that showed it; anything else → pending cleared and the failure recorded, so the
 * episode's popup is due again. No outcome for longer than PENDING_STALE_MS also reopens it.
 * Another token's outcome is not this popup's and changes nothing.
 */
export function popupSettled(state, outcome, now, staleMs = PENDING_STALE_MS) {
  const p = state.popupPending;
  if (!p) return { state, line: null };
  const kind = p.kind ?? "daemon";
  if (outcome && outcome.token === p.token) {
    if (delivered(outcome)) return { state: { ...state, popupShown: latch(state, kind, true), popupPending: null, lastPopupAt: p.since, popupFailedAt: null, popupFailReason: null }, line: `popup delivered: ${describeExit(outcome)}${outcome.acknowledged ? " (dismissed)" : ""}` };
    const why = `popup not delivered: ${describeExit(outcome)} after the grace`;
    return { state: { ...state, popupShown: latch(state, kind, false), popupPending: null, popupFailedAt: outcome.at, popupFailReason: reason(why) }, line: `${why}; the popup is due again` };
  }
  if (now - p.since <= staleMs) return { state, line: null };
  const why = `popup not confirmed: no outcome from its supervisor within ${Math.round(staleMs / 1000)} s`;
  return { state: { ...state, popupShown: latch(state, kind, false), popupPending: null, popupFailedAt: now, popupFailReason: reason(why) }, line: `${why}; the popup is due again` };
}

/**
 * The dead-man's check: `{ overdue, since, intervalS }`. Overdue when the last tick (or, never
 * ticked, the first SessionStart stamp) is older than twice the interval. Nothing is known
 * (no stamp of either kind) → not overdue.
 */
export function timerOverdue(state, now) {
  const intervalS = state.intervalS ?? DEFAULT_INTERVAL_S;
  const since = state.lastTickAt ?? state.firstSeenAt ?? null;
  if (since === null) return { overdue: false, since: null, intervalS };
  return { overdue: now - since > 2 * intervalS * 1000, since, intervalS };
}
