#!/usr/bin/env node
// hooks/user-prompt-submit.mjs — the continuity plugin's UserPromptSubmit hook. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage, never
// a block.
//
// What it does, as `additionalContext`: the liveness line, once per session, when this session
// has not heard it (a host that did not run hooks/session-start.mjs); and the context-pressure
// ask, when lib/pressure.mjs dueAsk() says one is due: the context size (the token usage the last
// reply recorded in the transcript, or, with none, the transcript's bytes since its last
// compaction marker through a calibrated ratio or / 8) has reached the ask point (default
// 175,000 tokens, and at least 40,000 past the compaction window's first recorded usage), or,
// after an ask or a handoff this session wrote, a further 150,000 tokens in the same window. A
// compaction re-arms it. The ask tells the model to run `/continuity:handoff` during this turn,
// while it still has the context the handoff needs; hooks/stop.mjs blocks at the end of a turn
// under the same rule.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. No `transcript_path`, or a transcript that cannot be measured → no
// ask, silently. A mark that cannot be written → the line is still given this once, with one
// errors.log line and a systemMessage. A config file with a problem is named once per session.
// `"pressure": "off"` / `"liveness": "off"` in the config file silence each.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { logError } from "../lib/errors.mjs";
import { renderLiveness } from "../lib/liveness.mjs";
import { dueAsk, handoffRequest } from "../lib/pressure.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";
import { sessionFlagsPath } from "../lib/paths.mjs";

export async function handle(input, { env = process.env } = {}) {
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
  if (config.pressure !== "off") {
    const ask = await dueAsk(input, "promptWarned", { config, flags, env });
    if (ask) {
      if (!ask.mark()) unmarked = true;
      parts.push(handoffRequest(ask.tokens, ask.basis, ask.step));
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
