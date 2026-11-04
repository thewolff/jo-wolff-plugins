// lib/state.mjs — the episode state the launchd tick keeps between runs, and the SessionStart
// hook reads for its dead-man's line.
//
// `${XDG_STATE_HOME:-~/.local/state}/ctx-watch/state.json`:
//
//   episode          "up" | "strike" | "down"
//   strikes          failing ticks in a row (0 when up)
//   popupShown       true once this episode's popup was delivered; re-armed by a passing tick
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
// the second failing tick in a row and asks for the popup, once per episode; a passing probe
// closes the episode and re-arms. `popup: true` is a request: the tick shows the dialog and
// then calls popupDelivered(state, outcome, now), which latches `popupShown` only on a delivery
// that worked, so a popup that could not be shown (no osascript, no GUI session) is tried again
// on the next failing tick. Never throws.
//
// readState(path) is the file, validated field by field (the enums, booleans, bounded counters
// and whole-epoch-ms stamps above; unknown fields dropped), or EMPTY when the file is missing,
// unreadable, not an object, or has any field out of shape: a state file that says
// `strikes: -100` or `popupShown: "yes"` would otherwise hold the popup off for the whole
// outage, so it is treated as absent and named in one errors.log line beside it.

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PLUGIN = "ctx-watch";
export const DEFAULT_INTERVAL_S = 300;
export const STRIKES_TO_DOWN = 2;
/** More failing ticks in a row than a year of 30 s ticks: anything beyond is not a count. */
export const MAX_STRIKES = 1_100_000;
export const MIN_INTERVAL_S = 30;
export const MAX_INTERVAL_S = 86_400 * 7;
const MAX_DATE_MS = 8.64e15;

/** `${XDG_STATE_HOME:-~/.local/state}/ctx-watch` (the hook runner's rule, repeated so the CLI shares it). */
export function stateDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), PLUGIN);
}

/** `<dir>/state.json`; `dir` defaults to stateDir(env) (the timer passes the directory it was installed with). */
export function statePath(env = process.env, dir = stateDir(env)) {
  return join(dir, "state.json");
}

export const EMPTY = Object.freeze({
  episode: "up",
  strikes: 0,
  popupShown: false,
  popupFailedAt: null,
  popupFailReason: null,
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

/** Each field's test and, for the message, its shape. */
const SHAPE = Object.freeze({
  episode: [(v) => v === "up" || v === "strike" || v === "down", '"up" | "strike" | "down"'],
  strikes: [(v) => Number.isInteger(v) && v >= 0 && v <= MAX_STRIKES, `a whole number 0..${MAX_STRIKES}`],
  popupShown: [isBool, "true | false"],
  popupFailedAt: [nullOr(validMs), "epoch ms | null"],
  popupFailReason: [nullOr(isStr), "a string | null"],
  downSince: [nullOr(validMs), "epoch ms | null"],
  lastTickAt: [nullOr(validMs), "epoch ms | null"],
  intervalS: [nullOr((v) => Number.isInteger(v) && v >= MIN_INTERVAL_S && v <= MAX_INTERVAL_S), `a whole number ${MIN_INTERVAL_S}..${MAX_INTERVAL_S} | null`],
  lastProbe: [nullOr(isProbe), "{ at, ok, reason, healed } | null"],
  lastPopupAt: [nullOr(validMs), "epoch ms | null"],
  firstSeenAt: [nullOr(validMs), "epoch ms | null"],
});

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
    state[k] = k === "lastProbe" && v ? { at: v.at, ok: v.ok, reason: v.reason ?? null, healed: v.healed ?? null } : v;
  }
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
 * One tick's transition. `result` is a `check()` result (`ok`, `reason`, `healed`); `now` ms.
 * `popup: true` asks the tick to show the dialog; see popupDelivered for the latch.
 */
export function step(state, result, now) {
  const base = { ...EMPTY, ...state, lastTickAt: now, lastProbe: { at: now, ok: result.ok, reason: result.reason ?? null, healed: result.healed?.detail ?? null } };
  if (result.ok) return { state: { ...base, episode: "up", strikes: 0, popupShown: false, popupFailedAt: null, popupFailReason: null, downSince: null }, popup: false };
  const strikes = Math.min((base.strikes ?? 0) + 1, MAX_STRIKES);
  if (strikes < STRIKES_TO_DOWN) return { state: { ...base, episode: "strike", strikes }, popup: false };
  return { state: { ...base, episode: "down", strikes, downSince: base.downSince ?? now }, popup: !base.popupShown };
}

/**
 * Record a popup's outcome (`{ started, detail }` from showPopup): delivered → `popupShown`
 * latched and `lastPopupAt` stamped; not delivered → `popupFailedAt` and the reason, and the
 * latch stays open so the next failing tick tries again.
 */
export function popupDelivered(state, outcome, now) {
  if (outcome.started) return { ...state, popupShown: true, lastPopupAt: now, popupFailedAt: null, popupFailReason: null };
  return { ...state, popupShown: false, popupFailedAt: now, popupFailReason: String(outcome.detail ?? "popup not shown").slice(0, 200) };
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
