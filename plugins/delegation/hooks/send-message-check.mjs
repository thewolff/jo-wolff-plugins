#!/usr/bin/env node
// hooks/send-message-check.mjs — PostToolUse on `SendMessage`: gate 3. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage.
//
// WHY: on Claude Code 2.1.318 a SendMessage to a target that cannot be reached returns
// `{"success":false,"message":"No agent named '…' is reachable.\nUse ListAgents …"}` with
// `is_error` unset (probe 1 of agent-scratch/jo-wolff-plugins/CLAUDE-CODE-DELEGATION-HOOKS-2026-11-04.md),
// so the model can read the failed send as a sent message and wait for a reply that never
// comes. (A message to a FINISHED subagent is not this case: Claude Code resumes it, measured
// in the same probe.)
//
// WHAT: `tool_response.success === false` → `{ decision: "block", reason }` where reason is the
// tool's own `message` followed by "this message was NOT delivered; spawn a new agent or fix
// the name". Per the hooks docs a PostToolUse block puts the reason next to the tool result.
// Any other shape (success true, no `success` field, a response that is not an object) →
// nothing. `off: true` in the config → null.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows; the send's own result is then the model's only signal.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, withFault } from "../lib/config.mjs";
import { NOT_DELIVERED } from "../lib/brief.mjs";

const HOOK = "send-message-check";

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  a block, a systemMessage, or null
 */
export function handle(input, { env = process.env } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off) return null;
  if (String(input?.tool_name ?? "") !== "SendMessage") return withFault(null, fault, HOOK);
  const r = input?.tool_response;
  if (!r || typeof r !== "object" || r.success !== false) return withFault(null, fault, HOOK);
  const message = typeof r.message === "string" && r.message.trim() ? r.message.trim() : "SendMessage returned success: false.";
  const to = typeof input?.tool_input?.to === "string" ? ` (to: ${input.tool_input.to})` : "";
  return withFault({ decision: "block", reason: `${message}${to}\n${NOT_DELIVERED} (a new \`Agent\` call, or \`SendMessage\` to a name that is running)` }, fault, HOOK);
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
