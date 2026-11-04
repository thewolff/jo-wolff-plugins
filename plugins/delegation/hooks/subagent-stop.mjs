#!/usr/bin/env node
// hooks/subagent-stop.mjs — SubagentStop: the Stopped-because warning. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage.
//
// WHAT: when `agent_type` is builder-class (config `builderClass`) and `last_assistant_message`
// has no final line `Stopped because: acceptance met | bound hit | told to stop`, answer with a
// `systemMessage` only. Never `decision: "block"`: a block here would send the subagent back to
// work on a formatting point, which is the spiral this plugin exists to stop. The warning
// reaches the parent's transcript, not the subagent.
//
// The last `Stopped because:` line in the text is the one judged (the report may quote the
// template above it). A missing `last_assistant_message` (older host, or an agent that ended
// on a tool call) is treated as "no line": the warning says the report ended without one.
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
  const type = typeof input?.agent_type === "string" ? input.agent_type : undefined;
  if (type === undefined || !isBuilderClass(type, config.builderClass)) return withFault(null, fault, HOOK);
  const verdict = stoppedBecause(input.last_assistant_message);
  if (verdict.valid) return withFault(null, fault, HOOK);
  return withFault({ systemMessage: stopWarning(type, input.agent_id, verdict) }, fault, HOOK);
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
