// lib/session-flags.mjs — the per-session marks: `<state>/sessions/<session>.json`, a JSON
// object whose keys are the things already done this session. `livenessSaid` and `configNoted`
// are ISO timestamps, once per session. `promptWarned` and `stopBlocked` are the context-pressure
// anchors, `{ epoch, tokens, at, by }`: the compaction window (lib/calibration.mjs `epoch`) and
// the context size of the last ask (`by: "ask"`) or of the turn a handoff this session wrote
// silenced (`by: "handoff"`), from which lib/pressure.mjs dueAsk() counts the next one. A 0.3
// file holds an ISO string there, which names no epoch: it counts as an earlier window, so the
// ask is re-armed.
//
// Keyed by session id so two concurrent sessions never share a mark: with one shared file the
// second session to reach the pressure threshold would be silently skipped. A session with no
// id gets the key derived from its transcript path, and one with neither shares "nosess".
//
// Fail-quiet both ways: an unreadable file is "nothing done yet", and a mark that cannot be
// written returns false so the caller can decide not to block (a block that cannot be made
// once-only must not be made at all).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionFlagsPath } from "./paths.mjs";

/** The session key of a hook input: session_id, else a tag of the transcript path, else "nosess". */
export function sessionKey(input) {
  if (input?.session_id) return String(input.session_id);
  if (input?.transcript_path) return `t-${Buffer.from(String(input.transcript_path)).toString("base64url")}`;
  return "nosess";
}

export function readFlags(key, env = process.env) {
  try {
    const json = JSON.parse(readFileSync(sessionFlagsPath(key, env), "utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}

/** Set `flag` to `value` (any JSON value) for the session; true when the file now holds it. */
export function setFlag(key, flag, value, env = process.env) {
  try {
    const path = sessionFlagsPath(key, env);
    mkdirSync(dirname(path), { recursive: true });
    const flags = readFlags(key, env);
    flags[flag] = value;
    writeFileSync(path, `${JSON.stringify(flags)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Set `flag` to the ISO time `now` for the session; true when the file now holds it. */
export function markFlag(key, flag, env = process.env, now = new Date()) {
  return setFlag(key, flag, now.toISOString(), env);
}
