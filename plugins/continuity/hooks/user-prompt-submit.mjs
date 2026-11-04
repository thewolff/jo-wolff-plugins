#!/usr/bin/env node
// hooks/user-prompt-submit.mjs — the continuity plugin's UserPromptSubmit hook. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage, never
// a block.
//
// What it does, as `additionalContext`, each at most once per session: the liveness line, when
// this session has not heard it (a host that did not run hooks/session-start.mjs); and the
// context-pressure warning, when the transcript's size against the machine's calibration puts
// the session at or past `threshold` (default 0.65) of the compaction target. The warning asks
// the model to run `/continuity:handoff` during this turn, while it still has the context the
// handoff needs; hooks/stop.mjs blocks once at the end of a turn for the same reason.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. No calibration yet (the machine has never compacted), no
// `transcript_path`, or a transcript that cannot be measured → no warning, silently: a
// fabricated estimate would produce warnings to dismiss. A mark that cannot be written → the
// line is still given this once, with one errors.log line and a systemMessage. `"pressure": "off"`
// / `"liveness": "off"` in the config file silence each.

import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { renderLiveness } from "../lib/liveness.mjs";
import { handoffRequest, pressure } from "../lib/pressure.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";
import { sessionFlagsPath } from "../lib/paths.mjs";

export function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "UserPromptSubmit") return null;
  const { config, problem } = readConfig(env);
  const key = sessionKey(input);
  const flags = readFlags(key, env);
  const parts = [];
  let unmarked = false;
  const mark = (flag) => {
    if (!markFlag(key, flag, env)) unmarked = true;
  };
  if (config.liveness !== "off" && !flags.livenessSaid) {
    parts.push(renderLiveness({ env }));
    mark("livenessSaid");
  }
  if (config.pressure !== "off" && !flags.promptWarned) {
    const p = pressure(input, { threshold: config.threshold, env });
    if (p) {
      mark("promptWarned");
      parts.push(handoffRequest(p.pct));
    }
  }
  if (problem && !flags.configNoted) {
    parts.push(`continuity: ${problem}.`);
    mark("configNoted");
  }
  const out = {};
  if (parts.length) out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: parts.join("\n\n") };
  if (unmarked) {
    // What was said this turn stands; what failed is the once-mark, so it may be said again.
    const where = sessionFlagsPath(key, env);
    logError("continuity", "UserPromptSubmit", `once-mark not written to ${where}; this turn's line may repeat`, env);
    out.systemMessage = `continuity: the session mark could not be written to ${where}; the line added this turn may repeat.`;
  }
  return Object.keys(out).length ? out : null;
}

if (invokedDirectly(import.meta.url)) runHook("UserPromptSubmit", import.meta.url, { plugin: "continuity", quiet: false });
