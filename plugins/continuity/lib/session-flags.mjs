// lib/session-flags.mjs — the once-per-session marks: `<state>/sessions/<session>.json`, a
// JSON object whose keys are the things already done this session (`livenessSaid`,
// `promptWarned`, `stopBlocked`), each an ISO timestamp.
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

/** Set `flag` for the session; true when the file now holds it. */
export function markFlag(key, flag, env = process.env, now = new Date()) {
  try {
    const path = sessionFlagsPath(key, env);
    mkdirSync(dirname(path), { recursive: true });
    const flags = readFlags(key, env);
    flags[flag] = now.toISOString();
    writeFileSync(path, `${JSON.stringify(flags)}\n`);
    return true;
  } catch {
    return false;
  }
}
