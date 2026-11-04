#!/usr/bin/env node
// hooks/session-start.mjs — SessionStart: the teaching half. The gate (hooks/spawn-gate.mjs)
// is the backstop; a fresh session is told the brief's shape before its first spawn, so the
// first spawn is not where the rule is learned. Runs under lib/hook-runner.mjs: exit 0
// always; a fault is one errors.log line and a systemMessage.
//
// WHAT: `hookSpecificOutput.additionalContext` = lib/brief.mjs sessionBlock(builderClass):
// the section skeleton inline (under 25 lines), the builder-class names from the config, the
// `Stopped because:` line, the CLAIM/CITE line, and which agent class fits which job. Every
// SessionStart source (startup, resume, clear, compact) gets it: a compact drops the earlier
// copy, and a resumed session may predate the plugin. `off: true` in the config → nothing.
//
// Subagents do not fire SessionStart on Claude Code, so the block reaches the main session
// only; a subagent's own spawns are still gated, and the gate's refusal carries the template.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and the session starts untaught; the gate still holds.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, withFault } from "../lib/config.mjs";
import { sessionBlock } from "../lib/brief.mjs";

const HOOK = "session-start";

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  an additionalContext, a systemMessage, or null
 */
export function handle(input, { env = process.env } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off) return null;
  if (input?.hook_event_name !== undefined && input.hook_event_name !== "SessionStart") return withFault(null, fault, HOOK);
  return withFault({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionBlock(config.builderClass) } }, fault, HOOK);
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
