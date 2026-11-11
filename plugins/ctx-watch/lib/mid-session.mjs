// lib/mid-session.mjs — what the mid-session hook (hooks/mid-session.mjs, 0.4.0) tells the agent
// while a session runs, and the per-session latch that keeps it to once per episode.
//
// It reads two files and spawns nothing: the timer's `<state>/state.json` (the launchd tick
// probes ctx every 5 min and keeps the episode there; lib/state.mjs) and the session's latch,
// `<state>/sessions/<session id>.json` = `{ down, stale }`: the `downSince` of the episode this
// session was told about (null once told it is back), and the tick stamp it was told was stale.
// A per-prompt hook that ran `ctx daemon status` would add its 0.15 s (or a hung ctx's whole
// bound) to every prompt; this costs one node start and two small file reads.
//
// decide(state, latch, now) → { say, latch }, `say` one of:
//   "stale"      the tick stamp (or, never ticked, the first SessionStart's) is older than
//                STALE_AFTER_MS (15 min) or three intervals, whichever is longer: the timer has
//                stopped, so the state cannot say whether ctx is up. Once per stamp. While stale,
//                nothing else is said: a down or a recovery read from it is not current news.
//   "down"       `episode: "down"` (two failing ticks in a row; one is a blip and says nothing)
//                of kind daemon (which includes `not healed: upgrade state unknown`) or upgrade
//                (stuck). Once per `downSince`. A semantic-only episode says nothing: the daemon
//                is up and ctx search answers lexically (SessionStart is the same).
//   "recovered"  this session was told of a down and the state no longer shows one: one line.
//   null         nothing to say: healthy, a strike, semantic, or already told.
//
// The latch is written before the answer is returned. A latch that cannot be written (state
// directory not writable) still lets the answer out, with a note that it may repeat: an agent told
// twice beats an agent never told. No session id: nothing is said, since nothing could latch it.
// SessionStart records its own telling of a down episode here (noteTold), so the first prompt does
// not repeat it and the recovery line still comes.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INTERVAL_S, readState, stateDir, statePath } from "./state.mjs";
import { shellQuote } from "./launchd.mjs";

/** The least age of the tick stamp at which the state is not trusted. */
export const STALE_AFTER_MS = 15 * 60 * 1000;
/** The events the hook answers, each with its own hookSpecificOutput.hookEventName. */
export const EVENTS = Object.freeze(["UserPromptSubmit", "PostToolUseFailure"]);
/** The CLI the `repair` and `install` commands name. */
export const CLI_PATH = fileURLToPath(new URL("../scripts/ctx-watch.mjs", import.meta.url));
const REASON_MAX = 240;
const MAX_DATE_MS = 8.64e15;

const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const validMs = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_DATE_MS;
const iso = (ms) => new Date(ms).toISOString();
const cut = (s) => (String(s).length > REASON_MAX ? `${String(s).slice(0, REASON_MAX - 1)}…` : String(s));

/** `<dir>/sessions/<session id>.json`. */
export const latchPath = (dir, sessionId) => join(dir, "sessions", `${safeId(sessionId)}.json`);

/** The latch at `path`; `{ down: null, stale: null }` when missing or out of shape. */
export function readLatch(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return { down: validMs(j?.down) ? j.down : null, stale: validMs(j?.stale) ? j.stale : null };
  } catch {
    return { down: null, stale: null };
  }
}

/** Write atomically; null, or the error. */
export function writeLatch(path, latch) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ down: latch.down, stale: latch.stale })}\n`);
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

/** Record that `sessionId` was told about the episode that went down at `downSince` (SessionStart's telling). */
export function noteTold(dir, sessionId, downSince) {
  const path = latchPath(dir, sessionId);
  return writeLatch(path, { ...readLatch(path), down: downSince });
}

/** The stamp the state is stale since, or null: the tick's, else the first SessionStart's, older than the bound. */
export function staleSince(state, now) {
  const since = state.lastTickAt ?? state.firstSeenAt ?? null;
  if (since === null) return null;
  const bound = Math.max(STALE_AFTER_MS, 3 * (state.intervalS ?? DEFAULT_INTERVAL_S) * 1000);
  return now - since > bound ? since : null;
}

const telling = (state) => state.episode === "down" && state.episodeKind !== "semantic" && state.downSince !== null;

/** What to say now, and the latch after saying it. */
export function decide(state, latch, now) {
  const stale = staleSince(state, now);
  if (stale !== null) return latch.stale === stale ? { say: null, latch } : { say: "stale", latch: { ...latch, stale } };
  if (telling(state)) return latch.down === state.downSince ? { say: null, latch } : { say: "down", latch: { ...latch, down: state.downSince } };
  if (latch.down !== null) return { say: "recovered", latch: { ...latch, down: null } };
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
    if (p && !p.ok) return `ctx-watch: the ctx outage reported earlier in this session ended, but the timer's latest probe (${iso(p.at)}) fails again: ${cut(p.reason ?? "no reason recorded")}; ctx-watch says so here if it stays down.`;
    return `ctx-watch: ctx is back up (the ctx-watch timer's probe passed${p ? ` at ${iso(p.at)}` : ""}); ctx search and history work again.`;
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
  const { say, latch } = decide(state, readLatch(path), at);
  if (!say) return null;
  const err = writeLatch(path, latch);
  const text = message(say, state, at, cliPath);
  const note = err ? `\n(ctx-watch could not record that it said this, so it may repeat: ${err.message})` : "";
  return { hookSpecificOutput: { hookEventName: event, additionalContext: `${text}${note}` } };
}
