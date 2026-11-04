// lib/paths.mjs — the one place every file the continuity plugin keeps is named, so the writer
// of each file and its reader cannot disagree about where it is. Pure path composition: nothing
// here touches the filesystem, and nothing here can throw on any input (an import that threw
// would escape a hook's try/catch, since ESM imports evaluate before the module body runs).
//
// Everything lives under `${XDG_STATE_HOME:-~/.local/state}/continuity` (declared as `state` in
// .claude-plugin/plugin.json and pruned by scripts/prune.mjs) or under
// `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json` (kept by design):
//
//   <state>/<session>.json          the pre-compaction snapshot, one per session (pruned after 30 days)
//   <state>/sessions/<session>.json the once-per-session flags: liveness said, pressure warned, stop blocked
//   <state>/heartbeat.ndjson        one record per PreCompact invocation (kept; trimmed on write)
//   <state>/calibration.ndjson      one {bytes, tokens, target} per compaction (kept; trimmed on write)
//   <state>/errors.log              the hook runner's fault log (kept)
//
// `os.homedir()` reads `$HOME` on POSIX, which is how the tests and the scenario runner redirect
// every path here: a temp HOME and temp XDG dirs, so no test can read or write the real machine's
// history. There is deliberately no env override for the state directory itself.

import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN = "continuity";
export const HEARTBEAT_FILE = "heartbeat.ndjson";
export const CALIBRATION_FILE = "calibration.ndjson";
export const ERRORS_FILE = "errors.log";
/** Files under the state directory that retention never removes. */
export const KEPT_FILES = Object.freeze([ERRORS_FILE, HEARTBEAT_FILE, CALIBRATION_FILE]);

const home = (env) => env.HOME || homedir();

/** `${XDG_STATE_HOME:-~/.local/state}/continuity`. */
export function stateDir(env = process.env) {
  const xdg = typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim() ? env.XDG_STATE_HOME : join(home(env), ".local", "state");
  return join(xdg, PLUGIN);
}

/** `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json`. */
export function configPath(env = process.env) {
  const xdg = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(home(env), ".config");
  return join(xdg, PLUGIN, "config.json");
}

// Claude Code's session ids are uuids and other hosts' look like `seat-name-1789498192-31073`;
// both are filename-safe already, but an id reaches the filesystem here, so it is narrowed to a
// fixed alphabet rather than trusted. An id that sanitises away entirely becomes "unknown":
// never a reason to skip a save, because a save attributed to nothing still beats no save.
export function sanitizeSessionId(id) {
  const cleaned = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned || "unknown";
}

export const snapshotPath = (sessionId, env = process.env) => join(stateDir(env), `${sanitizeSessionId(sessionId)}.json`);
export const sessionFlagsPath = (sessionId, env = process.env) => join(stateDir(env), "sessions", `${sanitizeSessionId(sessionId)}.json`);
export const heartbeatPath = (env = process.env) => join(stateDir(env), HEARTBEAT_FILE);
export const calibrationPath = (env = process.env) => join(stateDir(env), CALIBRATION_FILE);
