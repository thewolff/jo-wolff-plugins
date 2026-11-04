#!/usr/bin/env node
// hooks/session-start.mjs — the continuity plugin's SessionStart hook. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage, never
// a block.
//
// What it does, as `additionalContext`: after a compaction (`source: "compact"`) it injects the
// snapshot hooks/pre-compact.mjs saved for this session and removes the file (a snapshot over
// 20,000 characters is cut, says so, and is kept); when there is no snapshot to restore, it says
// that this compaction's state was not restored and what the heartbeat recorded for this
// session's save. On every start it adds the liveness line: the newest save's result and the age
// of the last success, or a short block saying no save ever succeeded. The line is marked said for
// the session, so hooks/user-prompt-submit.mjs does not repeat it.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. No snapshot, or one older than a day, or one that does not parse →
// nothing restored, said in one line, and the liveness line. `"liveness": "off"` in the config
// file silences the line; `"snapshot": "off"` skips the restore. A config file with a problem is
// named once per session (the once-mark is shared with the other hooks) and the defaults apply. A
// once-mark that cannot be written is one errors.log line and a systemMessage; the line itself is
// still given.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { logError } from "../lib/errors.mjs";
import { lastSaveFor, renderLiveness } from "../lib/liveness.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";
import { sanitizeSessionId, sessionFlagsPath } from "../lib/paths.mjs";
import { restore } from "../lib/snapshot.mjs";

export function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "SessionStart") return null;
  const { config, problem } = readConfig(env);
  const key = sessionKey(input);
  const parts = [];
  if (config.snapshot !== "off" && input.source === "compact") {
    const restored = restore(input, { env });
    if (restored) parts.push(restored);
    else parts.push(notRestored(lastSaveFor(sanitizeSessionId(input.session_id), { env })));
  }
  let systemMessage;
  if (config.liveness !== "off") {
    parts.push(renderLiveness({ env }));
    if (!markFlag(key, "livenessSaid", env)) {
      // The line was still given; what failed is the once-mark, so the prompt hook will repeat it.
      const where = sessionFlagsPath(key, env);
      logError("continuity", "SessionStart", `once-mark not written to ${where}; the liveness line will repeat at the first prompt`, env);
      systemMessage = `continuity: the session mark could not be written to ${where}; the liveness line will repeat once at the first prompt.`;
    }
  }
  if (problem && !readFlags(key, env).configNoted) {
    parts.push(`continuity: ${problem}.`);
    markFlag(key, "configNoted", env);
  }
  if (!parts.length && !systemMessage) return null;
  const out = {};
  if (parts.length) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") };
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

// After a compaction with nothing to restore, the model must not assume a restore it never got.
function notRestored(save) {
  const why = !save
    ? "no pre-compaction save was recorded for this session"
    : save.outcome === "ok"
      ? `the save recorded \`ok\` at ${save.at}, but its snapshot is gone or unreadable`
      : save.outcome === "started"
        ? `the save started at ${save.at} and recorded no result: it did not finish`
        : `the save recorded \`${save.outcome}\` at ${save.at}`;
  return `continuity: **this compaction's state was not restored**: ${why}. Nothing from before the compaction is in context beyond what the host kept; reconstruct from the repository and say that you are reconstructing.`;
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "continuity", quiet: false });
