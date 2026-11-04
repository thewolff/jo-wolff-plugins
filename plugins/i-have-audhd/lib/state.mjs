// state.mjs — where the enforcement half keeps its inspectable traces.
//
// WHY A STATE DIRECTORY AT ALL
//   Fail-open machinery that leaves no trace is indistinguishable from machinery that was
//   never wired. Every skip, every warning, every swallowed error goes to a file under
//   ~/.claude/.i-have-audhd-state/ so an operator can answer "did it run?" by looking
//   rather than by believing. The loop guard's per-session hash and the judge cache live
//   there too.
//
// WHY LOGGING SWALLOWS ITS OWN FAILURES
//   A read-only home must not turn a fail-open hook into a crashing one, so appendLog never
//   throws. A line that cannot be written is still not silent: it becomes a fault (below), so
//   the hook's warning line says the state directory could not be written.
//
// FAULTS: FAIL OPEN, NEVER FAIL SILENT
//   A fault is anything that stops a hook doing its job: stdin that is empty or not a JSON
//   object, a throw, a state or profile file that cannot be read, parsed or written. logFault
//   appends one line `<iso> <file> <reason>` to errors.log and remembers the fault for this
//   process; faultWarning turns every fault of the run into the ONE line the hook adds to its
//   systemMessage, naming the hook, the reasons and errors.log (or that errors.log could not be
//   written either). The hook still exits 0 and still allows: its own fault never blocks.

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir() {
  return join(homedir(), ".claude", ".i-have-audhd-state");
}

// The kill switch is read per invocation with existsSync, never cached, and never read from a
// module-scope environment variable — env is frozen for the life of the host process that
// spawns this hook, so an env switch cannot be thrown without relaunching the host. A flag
// file disables enforcement within one turn. Same precedent as the identifier URL resolver.
export function killSwitchPath() {
  return join(homedir(), ".claude", ".i-have-audhd-off");
}

export function resumeMarkerPath(sessionId) {
  return join(stateDir(), `resume-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}`);
}

// Present once the session-start hook has shown its no-judge notice (hooks/i-have-audhd-inject.mjs).
export function judgeNoticeMarkerPath() {
  return join(stateDir(), "judge-notice-shown");
}

export function lastBlockedPath(sessionId) {
  return join(stateDir(), `last-blocked-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

// The warn findings of the session's latest checked stop, waiting for its next turn
// (lib/pending.mjs writes and consumes it).
export function pendingWarningPath(sessionId) {
  return join(stateDir(), `pending-warn-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function sha256hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

// Writes one timestamped line; returns the error, or null when the line landed.
function writeLine(dir, file, text) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${new Date().toISOString()} ${oneLine(text)}\n`);
    return null;
  } catch (err) {
    return err;
  }
}

// This process's faults, in order, and whether every one reached errors.log.
const faults = [];
let faultsLogged = true;

// One timestamped line to <dir>/<file>; dir defaults to the shared state directory and exists
// as a parameter so the judge machinery can be tested against a temp home. Never throws; a line
// that cannot be written is recorded as a fault of lib/state.mjs.
export function appendLog(file, text, dir = stateDir()) {
  const err = writeLine(dir, file, text);
  if (err) logFault("lib/state.mjs", `could not write ${join(dir, file)} (${err.code || err.message})`);
}

// One fault of `file` (the plugin-relative source file): one errors.log line, and a reason for the
// hook's warning line. Never throws.
export function logFault(file, reason) {
  const line = `${file} ${oneLine(reason)}`;
  if (!faults.includes(line)) faults.push(line);
  if (writeLine(stateDir(), "errors.log", line)) faultsLogged = false;
}

// The one warning line for every fault this process logged, or "" when there were none.
export function faultWarning(hookFile) {
  if (!faults.length) return "";
  const log = join(stateDir(), "errors.log");
  const where = faultsLogged ? `logged to ${log}` : `could not be logged to ${log} either`;
  return `i-have-audhd ${hookFile} failed open (its fault blocks nothing): ${faults.join("; ")} (${where})`;
}
