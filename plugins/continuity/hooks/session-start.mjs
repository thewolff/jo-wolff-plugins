#!/usr/bin/env node
// hooks/session-start.mjs — the continuity plugin's SessionStart hook. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage, never
// a block.
//
// What it does, as `additionalContext`: after a compaction (`source: "compact"`) it injects the
// snapshot hooks/pre-compact.mjs saved for this session and removes the file (a snapshot over
// 20,000 characters is cut, says so, and is kept); on every start it adds the liveness line,
// one sentence saying when the pre-compaction save last succeeded on this machine, or a short
// block saying it never has. The line is marked said for the session, so
// hooks/user-prompt-submit.mjs does not repeat it.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. No snapshot, or one older than a day, or one that does not parse →
// nothing restored, the liveness line alone. `"liveness": "off"` in the config file silences
// the line; `"snapshot": "off"` skips the restore. A config file that does not parse is named
// once in the same output and the defaults apply. A once-mark that cannot be written is one
// errors.log line and a systemMessage; the line itself is still given.

import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { renderLiveness } from "../lib/liveness.mjs";
import { markFlag, sessionKey } from "../lib/session-flags.mjs";
import { sessionFlagsPath } from "../lib/paths.mjs";
import { restore } from "../lib/snapshot.mjs";

export function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "SessionStart") return null;
  const { config, problem } = readConfig(env);
  const parts = [];
  if (config.snapshot !== "off" && input.source === "compact") {
    const restored = restore(input, { env });
    if (restored) parts.push(restored);
  }
  let systemMessage;
  if (config.liveness !== "off") {
    parts.push(renderLiveness({ env }));
    const key = sessionKey(input);
    if (!markFlag(key, "livenessSaid", env)) {
      // The line was still given; what failed is the once-mark, so the prompt hook will repeat it.
      const where = sessionFlagsPath(key, env);
      logError("continuity", "SessionStart", `once-mark not written to ${where}; the liveness line will repeat at the first prompt`, env);
      systemMessage = `continuity: the session mark could not be written to ${where}; the liveness line will repeat once at the first prompt.`;
    }
  }
  if (problem) parts.push(`continuity: ${problem}.`);
  if (!parts.length && !systemMessage) return null;
  const out = {};
  if (parts.length) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") };
  if (systemMessage) out.systemMessage = systemMessage;
  return out;
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "continuity", quiet: false });
