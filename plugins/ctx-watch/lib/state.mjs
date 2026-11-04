// lib/state.mjs — the episode state the launchd tick keeps between runs, and the SessionStart
// hook reads for its dead-man's line.
//
// `${XDG_STATE_HOME:-~/.local/state}/ctx-watch/state.json`:
//
//   episode      "up" | "strike" | "down"
//   strikes      failing ticks in a row (0 when up)
//   popupShown   true once this episode's popup went out; re-armed by a passing tick
//   downSince    ms of the tick that opened the episode's down, or null
//   lastTickAt   ms of the last `tick` (the dead-man's stamp)
//   intervalS    the StartInterval the last `install` wrote, so the hook knows 2× of it
//   lastProbe    { at, ok, reason, healed } from the last tick
//   lastPopupAt  ms of the last popup
//   firstSeenAt  ms the SessionStart hook first ran: a timer that never ticked is overdue
//                measured from here (ledger's digest dead-man's switch does the same)
//
// step(state, result, now) → { state, popup }: a failing probe strikes once, then goes down on
// the second failing tick in a row and asks for the popup, once per episode; a passing probe
// closes the episode and re-arms. Never throws; a missing or unreadable file is EMPTY.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PLUGIN = "ctx-watch";
export const DEFAULT_INTERVAL_S = 300;
export const STRIKES_TO_DOWN = 2;

/** `${XDG_STATE_HOME:-~/.local/state}/ctx-watch` (the hook runner's rule, repeated so the CLI shares it). */
export function stateDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), PLUGIN);
}

export function statePath(env = process.env) {
  return join(stateDir(env), "state.json");
}

export const EMPTY = Object.freeze({
  episode: "up",
  strikes: 0,
  popupShown: false,
  downSince: null,
  lastTickAt: null,
  intervalS: null,
  lastProbe: null,
  lastPopupAt: null,
  firstSeenAt: null,
});

/** The state at `path`, or EMPTY when missing, unreadable, or not an object. */
export function readState(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ...EMPTY };
    return { ...EMPTY, ...j };
  } catch {
    return { ...EMPTY };
  }
}

/** Write atomically (temp file + rename). Returns true, or false with the error on `writeState.lastError`. */
export function writeState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, path);
    return true;
  } catch (err) {
    writeState.lastError = err;
    return false;
  }
}

/**
 * One tick's transition. `result` is a `check()` result (`ok`, `reason`, `healed`); `now` ms.
 */
export function step(state, result, now) {
  const base = { ...EMPTY, ...state, lastTickAt: now, lastProbe: { at: now, ok: result.ok, reason: result.reason ?? null, healed: result.healed?.detail ?? null } };
  if (result.ok) return { state: { ...base, episode: "up", strikes: 0, popupShown: false, downSince: null }, popup: false };
  const strikes = (base.strikes ?? 0) + 1;
  if (strikes < STRIKES_TO_DOWN) return { state: { ...base, episode: "strike", strikes }, popup: false };
  const popup = !base.popupShown;
  return { state: { ...base, episode: "down", strikes, downSince: base.downSince ?? now, popupShown: true, lastPopupAt: popup ? now : base.lastPopupAt }, popup };
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
