#!/usr/bin/env node
// hooks/subagent-stop.mjs — SubagentStop: the Stopped-because warning. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage.
//
// WHAT: when `agent_type` is builder-class (config `builderClass`, minus `readOnlyAgents`) and
// the last non-empty line of `last_assistant_message` is not `Stopped because: acceptance met |
// bound hit | told to stop` (a detail may follow the value), answer with a `systemMessage` only.
// Never `decision: "block"`: a block here would send the subagent back to work on a formatting
// point, which is the spiral this plugin exists to stop.
//
// WHO SEES IT: a SubagentStop `systemMessage` is shown to the user, not to the parent model
// (hooks docs: "Warning message shown to the user"; SubagentStop has no additionalContext). The
// warning is therefore worded for the person reading the session. On OMP the adapter adds the
// same text to the parent's context instead.
//
// AN EMPTY `agent_type` is not builder-class here: Claude Code fires SubagentStop for its own
// internal agents (prompt suggestions, /btw) with an empty agent_type (hooks docs). Only the
// spawn gate reads a missing type as `general-purpose`.
//
// A missing `last_assistant_message` (older host, or an agent that ended on a tool call) is
// treated as "no line": the warning says the report ended without one.
//
// `agent_type` and `last_assistant_message` are documented SubagentStop fields (hooks docs,
// fetched 2026-11-04). `off: true` in the config → null.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows; the stop proceeds unwarned.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, withFault } from "../lib/config.mjs";
import { isBuilderClass, stoppedBecause, stopWarning } from "../lib/brief.mjs";

const HOOK = "subagent-stop";

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  a systemMessage or null
 */
export function handle(input, { env = process.env } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off) return null;
  const type = typeof input?.agent_type === "string" ? input.agent_type.trim() : "";
  if (type === "" || !isBuilderClass(type, config.builderClass, config.readOnlyAgents)) return withFault(null, fault, HOOK);
  const verdict = stoppedBecause(input.last_assistant_message);
  if (verdict.valid) return withFault(null, fault, HOOK);
  return withFault({ systemMessage: stopWarning(type, input.agent_id, verdict) }, fault, HOOK);
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
