#!/usr/bin/env node
// hooks/stop.mjs — the ctx-watch plugin's Stop hook: the `consult-history` check
// (lib/consult-history.mjs). Runs under lib/hook-runner.mjs: exit 0 always; a fault is one
// errors.log line and a systemMessage, never a block.
//
// What it does, in order:
//   1. The switch: ~/.claude/.ctx-watch-off present, or ~/.claude/ctx-watch.json
//      `checks.consult-history: "off"` → nothing (the resume marker is still consumed, so a
//      later `warn` does not fire for a resume that happened while it was off).
//   2. The resume marker for this session_id (left by hooks/session-start.mjs on `source`
//      resume or compact) is read and removed, whether or not the check fires.
//   3. The transcript (`transcript_path`) is scanned: resume trigger (no ctx history call since
//      the marker's time), then phrase trigger (the final message says "as discussed" or one of
//      the other PHRASES and this turn made no ctx history call).
//   4. A finding in `warn` mode is `{ systemMessage: "ctx-watch: <finding>" }` (the person sees
//      it; the turn is over) and one line in <state>/checks.log. In `block` mode it is
//      `{ decision: "block", reason }` naming the `ctx search` command and the way out, unless
//      `stop_hook_active` is true (this Stop already follows a block: never twice), in which
//      case it warns.
//
// How it fails: stdin not JSON, a throw, or no answer in 4 s → the runner's fail-open line.
// No `transcript_path`, or a file that cannot be read → nothing to scan: no finding, no block
// (one errors.log line when a resume marker was pending, since the check could not run for
// it). A config file that is not usable → errors.log line, default `warn`. A marker that cannot
// be removed → errors.log line; the check still runs. checks.log unwritable → errors.log line.
//
// handle() runs on a worker thread: return a plain object; never process.exit() or write stdout.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { stateDir } from "../lib/state.mjs";
import { CHECK, readMode, consumeResumeMarker, readTranscript, finalText, finding, wayOut } from "../lib/consult-history.mjs";

const HOOK = "Stop";
const PLUGIN = "ctx-watch";

/** One line per finding, `<iso> <mode> <session> <message>`, in <state>/checks.log; never throws. */
function logFinding(dir, line, env) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "checks.log"), line + "\n");
  } catch (err) {
    logError(PLUGIN, HOOK, `checks.log not written (${err.message}): ${line}`, env);
  }
}

/**
 * @param {object} input  the Stop payload: session_id, transcript_path, stop_hook_active, last_assistant_message (OMP seats)
 * @returns {object|null}
 */
export function handle(input, { env = process.env, now = Date.now, dir = stateDir(env) } = {}) {
  const sessionId = typeof input.session_id === "string" && input.session_id.trim() ? input.session_id.trim() : null;
  const { mode, fault } = readMode(env);
  if (fault) logError(PLUGIN, HOOK, fault, env);
  // The marker is one-shot: consumed on this Stop whatever the mode says.
  const marker = sessionId ? consumeResumeMarker(dir, sessionId) : { at: null, error: null };
  if (marker.error) logError(PLUGIN, HOOK, `resume marker for ${sessionId} not removed (${marker.error.message}); it will be read again on the next Stop`, env);
  if (mode === "off") return null;
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const entries = transcriptPath ? readTranscript(transcriptPath) : [];
  if (!entries.length) {
    if (marker.at !== null) logError(PLUGIN, HOOK, `${CHECK}: no transcript to scan (${transcriptPath || "no transcript_path"}); the resume of ${sessionId} was not checked`, env);
    return null;
  }
  const text = finalText(input, entries);
  const f = finding({ entries, resumedAt: marker.at, text });
  if (!f) return null;
  const blocked = mode === "block" && input.stop_hook_active !== true;
  logFinding(dir, `${new Date(now()).toISOString()} ${blocked ? "block" : "warn"} ${sessionId ?? "-"} ${f.trigger} ${f.message}`, env);
  if (!blocked) return { systemMessage: `ctx-watch: ${f.message}` };
  return {
    decision: "block",
    reason: `ctx-watch (${CHECK}): ${f.head}. Run \`${f.command}\` (or the ctx MCP search) and read what it finds before going on. ${wayOut()}`,
  };
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: PLUGIN, quiet: false });
