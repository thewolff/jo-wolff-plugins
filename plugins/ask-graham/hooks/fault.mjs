// fault.mjs — where the Claude Code hooks put their own faults, so a hook that fails open is not
// also silent.
//
// A fault is anything that stops a hook doing its job: stdin that is empty or not a JSON object, a
// throw, a state file that cannot be read or written, a config file that names no valid value, a
// transcript that cannot be read. Each one appends a line
//   <iso time> <hook file> <reason>
// to ${XDG_STATE_HOME:-$HOME/.local/state}/ask-graham/errors.log (XDG_STATE_HOME counts only when it
// is an absolute path, as with the blocked records), and the hook's reply carries one systemMessage
// line naming the hook, the reasons, and the log. The hook still exits 0 and still allows: a
// hook's own fault never blocks a prompt or a stop.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The plugin's state directory: the blocked records and errors.log live under it. */
export function stateDir(env = process.env, home = homedir()) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "ask-graham");
}

export function errorsLogPath(env = process.env, home = homedir()) {
  return join(stateDir(env, home), "errors.log");
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

/**
 * Collects one hook run's faults. `add(reason)` logs a line at once (never throws); `warning()` is
 * the one-line systemMessage for all of them, or null when there were none.
 */
export function faults(hookFile, { env = process.env, home = homedir(), now = () => new Date() } = {}) {
  const reasons = [];
  const path = errorsLogPath(env, home);
  let logged = true;
  return {
    reasons,
    add(reason) {
      const line = oneLine(reason);
      reasons.push(line);
      try {
        mkdirSync(join(path, ".."), { recursive: true });
        appendFileSync(path, `${now().toISOString()} ${hookFile} ${line}\n`);
      } catch {
        logged = false; // nowhere to log: the warning line says so
      }
    },
    warning(outcome) {
      if (reasons.length === 0) return null;
      const where = logged ? `logged to ${path}` : `could not be logged to ${path}`;
      return `ask-graham ${hookFile} failed open (${outcome}): ${reasons.join("; ")} (${where})`;
    },
  };
}

/** The message of anything thrown, for one log line. */
export const errText = (e) => (e && typeof e.message === "string" ? e.message : String(e));
