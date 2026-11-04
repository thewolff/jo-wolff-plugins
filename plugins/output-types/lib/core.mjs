// core.mjs — the pure parts of the session-start injection, kept out of the hook so each branch
// can be tested without a process.
//
// The hook (hooks/output-types-inject.mjs) owns I/O: stdin, the contract file, stdout, exit.
// This module owns what the text is, where a fault is written down, and what the reply looks like.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Line-anchored: the contract's own prose names the markers, and must not match.
export const START = "\n<!-- inject:start -->\n";
export const END = "\n<!-- inject:end -->";

// The only text the plugin owns outside the contract file.
export const POINTER =
  "\nThe rest of the contract (receipts, the seven rules, what unlabeled prose still owes, degraded " +
  "reports, commands handed to a person) is in the `output-types` skill. Load it before writing " +
  "anything someone will act on.";

export const WARN_MARKERS = "The output-types core could not load: its markers are missing from the contract file.";
export const WARN_LOAD = "The output-types core could not load this session.";

/** True when OUTPUT_TYPES_INJECT is `off`, in any case. Any other value, or none, leaves it on. */
export function isOff(env = process.env) {
  return String(env.OUTPUT_TYPES_INJECT || "").toLowerCase() === "off";
}

/** The text between the line-anchored markers, trimmed, with the pointer appended; null when a marker is missing. */
export function extractCore(md) {
  const text = String(md);
  const start = text.indexOf(START);
  const end = start === -1 ? -1 : text.indexOf(END, start + START.length);
  if (start === -1 || end === -1) return null;
  return text.slice(start + START.length, end).trim() + POINTER;
}

/** ${XDG_STATE_HOME:-~/.local/state}/output-types — the same layout ledger uses. */
export function stateDir(env = process.env) {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(base, "output-types");
}

export function errorsLogPath(env = process.env) {
  return join(stateDir(env), "errors.log");
}

/**
 * Append one line, `<iso> <file> <reason>`, to errors.log. Never throws.
 * Returns the log path when the line landed, null when the state dir could not be written.
 */
export function logError(file, reason, env = process.env, now = new Date()) {
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "errors.log");
    appendFileSync(path, `${now.toISOString()} ${file} ${String(reason).replace(/\s+/g, " ").trim()}\n`);
    return path;
  } catch {
    return null;
  }
}

/** The SessionStart reply carrying the core. */
export function successReply(text) {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

/**
 * The SessionStart reply for a fault: the warning goes to the model (additionalContext) and to the
 * person (systemMessage), followed by where the reason went — or the reason itself when it could
 * not be written down, so it is never lost.
 */
export function failureReply(warning, reason, loggedTo) {
  const line = loggedTo ? `${warning} Reason logged to ${loggedTo}.` : `${warning} Reason: ${String(reason).replace(/\s+/g, " ").trim()}`;
  return { systemMessage: line, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } };
}
