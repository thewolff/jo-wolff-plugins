// lib/errors.mjs — the hooks' own errors.log writer: the runner's line format and path
// (lib/hook-runner.mjs, kept byte-identical to plugin-kit's, so it is not edited here), written
// through lib/bounded-log.mjs so the file keeps only its newest ERRORS_MAX_LINES lines.
//
// The runner's own fault lines (stdin not JSON, a deadline, a throw) still go through its plain
// append; the next line written here trims them with the rest. When the rename-swap cannot be
// made (a read-only state directory with a writable errors.log inside), the line falls back to
// the runner's append, so a fault is never lost for want of a trim. Never throws.

import { appendBounded } from "./bounded-log.mjs";
import { errorsLogPath, logError as appendError } from "./hook-runner.mjs";

export const ERRORS_MAX_LINES = 200;

/** One `<iso> <hook> <message>` line in `<state>/<plugin>/errors.log`, trimmed to ERRORS_MAX_LINES. */
export function logError(plugin, hook, message, env = process.env) {
  try {
    appendBounded(errorsLogPath(plugin, env), `${new Date().toISOString()} ${hook} ${String(message).replace(/\s+/g, " ").trim()}`, ERRORS_MAX_LINES);
  } catch {
    appendError(plugin, hook, message, env);
  }
}
