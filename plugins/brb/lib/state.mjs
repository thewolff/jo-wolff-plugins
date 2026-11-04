// state.mjs — where brb keeps the away flag and the digest, one directory per session.
//
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/away.json   the hold: since, note, counts
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/digest.md   held items, append-only while away
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/archive/<ts>.md   digests `back` released
//   ${XDG_STATE_HOME:-~/.local/state}/brb/<session id>/away.lock   held while away.json is read-modified-written
//   ${XDG_CONFIG_HOME:-~/.config}/brb/config.json                  optional: onFireCap, idleStops
//
// away.json is the one record that the session is away: present means away, absent means home.
// It is written whole through a temp file and a rename, so a reader never sees half of it.
// Every function here returns a value or throws; the hooks run under lib/hook-runner.mjs, which
// turns a throw into one errors.log line and an allow. A missing or unparsable config file is
// the defaults, and a missing or unparsable away.json is "home" (readAway returns null).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({ onFireCap: 3, idleStops: 2 });

/** `${XDG_STATE_HOME:-~/.local/state}/brb`. */
export function stateRoot(env = process.env) {
  const xdg = env.XDG_STATE_HOME?.trim() ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(xdg, "brb");
}

/** `${XDG_CONFIG_HOME:-~/.config}/brb/config.json`. */
export function configPath(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), ".config");
  return join(xdg, "brb", "config.json");
}

/** A session id as a directory name: anything outside [A-Za-z0-9._-] becomes `_`; empty is `no-session`. */
export function sessionKey(sessionId) {
  const s = typeof sessionId === "string" ? sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_") : "";
  return s && s !== "." && s !== ".." ? s.slice(0, 120) : "no-session";
}

export function sessionDir(sessionId, env = process.env) {
  return join(stateRoot(env), sessionKey(sessionId));
}

const awayPath = (sessionId, env) => join(sessionDir(sessionId, env), "away.json");
/** `<session dir>/digest.md`, the live digest. */
export const digestPath = (sessionId, env = process.env) => join(sessionDir(sessionId, env), "digest.md");

/** How long a writer waits for the session lock before giving up, and when a held lock is stale. */
export const LOCK_WAIT_MS = 2_000;
export const LOCK_STALE_MS = 10_000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run fn() holding `<session dir>/away.lock`, the one lock every away.json read-modify-write
 * takes (the hold command; `brb`, `back` and the turn reset in the prompt hook; the Stop
 * hook's write), so a `back` cannot land between another writer's re-read and its write. The
 * lock is an O_EXCL create; a lock older than LOCK_STALE_MS is a crashed holder's and is
 * removed; past LOCK_WAIT_MS this throws (`brb: the hold is locked`), which the hook runner
 * logs and the hold command reports. fn re-reads away.json itself.
 */
export function withAwayLock(sessionId, env, fn) {
  const dir = sessionDir(sessionId, env);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "away.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue; // released between the create and the stat
    }
    if (Date.now() >= deadline) throw new Error(`brb: the hold is locked (${lock})`);
    sleep(20);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** The effective config: the file's integer fields over the defaults; a missing or bad file is the defaults. */
export function loadConfig(env = process.env) {
  const out = { ...DEFAULT_CONFIG };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const v = parsed[key];
    if (Number.isInteger(v) && v >= 0) out[key] = v;
  }
  return out;
}

/** A fresh away record: when the hold began, the note typed after `brb`, zeroed counters, no backstop yet this turn. */
export function freshAway({ since = new Date().toISOString(), note = "" } = {}) {
  return { since, note, held: 0, onFire: 0, toolLessStops: 0, nothingNewStops: 0, backstopped: false, seen: [], lastStop: null };
}

/** The session's away record, or null when home (no file, or a file that does not parse). */
export function readAway(sessionId, env = process.env) {
  let text;
  try {
    text = readFileSync(awayPath(sessionId, env), "utf8");
  } catch {
    return null;
  }
  return parseAway(text);
}

/** away.json's text → the typed away record, or null (home) when it does not parse or has no `since`. */
export function parseAway(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.since !== "string") return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    since: parsed.since,
    note: typeof parsed.note === "string" ? parsed.note : "",
    held: n(parsed.held),
    onFire: n(parsed.onFire),
    toolLessStops: n(parsed.toolLessStops),
    nothingNewStops: n(parsed.nothingNewStops),
    backstopped: parsed.backstopped === true,
    seen: Array.isArray(parsed.seen) ? parsed.seen.filter((s) => typeof s === "string") : [],
    lastStop: parsed.lastStop && typeof parsed.lastStop === "object" ? parsed.lastStop : null,
  };
}

/** Write the away record whole (temp file + rename). Creates the session directory. */
export function writeAway(sessionId, away, env = process.env) {
  const dir = sessionDir(sessionId, env);
  mkdirSync(dir, { recursive: true });
  const path = awayPath(sessionId, env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(away));
  renameSync(tmp, path);
  return path;
}

/** Remove the away record; the session is home. The digest is left where it is. */
export function clearAway(sessionId, env = process.env) {
  rmSync(awayPath(sessionId, env), { force: true });
}

/** Append one digest entry: a timestamp heading, one line per held item, the closing ask when there is one. */
export function appendDigest(sessionId, { at = new Date().toISOString(), lines = [], closingAsk = null }, env = process.env) {
  const dir = sessionDir(sessionId, env);
  mkdirSync(dir, { recursive: true });
  const body = [`## ${at}`, ...lines.map((l) => (/^\s*([-*+]|\d+[.)])\s+/.test(l) ? l.trim() : `- ${l.trim()}`)), ...(closingAsk ? [`closing ask: ${closingAsk.trim()}`] : []), ""];
  appendFileSync(digestPath(sessionId, env), `${body.join("\n")}\n`);
}

/** The digest's body as written, "" when there is none. */
export function readDigest(sessionId, env = process.env) {
  try {
    return readFileSync(digestPath(sessionId, env), "utf8");
  } catch {
    return "";
  }
}

/** Move the digest to `archive/<ts>.md`; the archived path, or null when there was no digest. */
export function archiveDigest(sessionId, env = process.env, at = new Date().toISOString()) {
  const from = digestPath(sessionId, env);
  if (!existsSync(from)) return null;
  const archive = join(sessionDir(sessionId, env), "archive");
  mkdirSync(archive, { recursive: true });
  let to = join(archive, `${at.replace(/[:.]/g, "-")}.md`);
  for (let n = 2; existsSync(to); n++) to = join(archive, `${at.replace(/[:.]/g, "-")}-${n}.md`);
  renameSync(from, to);
  return to;
}

/** The digest as `back` and `pending` print it: a header line, then the body or "(nothing held)". */
export function renderDigest(away, body) {
  const n = away.held;
  const header = `brb digest — held since ${away.since}${away.note ? ` (${away.note})` : ""}, ${n} item${n === 1 ? "" : "s"}`;
  return body.trim() ? `${header}\n\n${body.trim()}` : `${header}\n\n(nothing held)`;
}
