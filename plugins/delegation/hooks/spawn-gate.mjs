#!/usr/bin/env node
// hooks/spawn-gate.mjs — PreToolUse on `Agent` (the `Task` alias fires the same matcher):
// gates 1, 4 and 2 on every subagent spawn. Runs under lib/hook-runner.mjs: exit 0 always; a
// fault is one errors.log line and a systemMessage, never a deny.
//
// GATE 1  the prompt (`tool_input.prompt`) has no `## How it fails` heading → deny.
// GATE 4  `tool_input.subagent_type` is builder-class (config `builderClass`; a missing type is
//         `general-purpose`) and the prompt has no `## Spiral bound` heading → deny. A type in
//         config `readOnlyAgents` (reviewer-codex, scout, reader, …) is never builder-class.
// GATE 2  builder-class and this session has no pattern-check receipt
//         (<git root of cwd>/.pattern-check/<session_id>.md, or pattern-check's state copy) → deny,
//         naming the pattern-check command and `requirePatternCheck: false` as the way out. Not in
//         a git repository, or pattern-check not installed → allow, one skipped.log line.
// The deny reason names the missing heading and the fix (lib/brief.mjs headingReason, at most
// 300 characters) or the exact command (lib/receipt.mjs receiptReason), and points at
// templates/builder-brief.md. It reaches the model as an `is_error` tool result prefixed
// `PreToolUse:Agent hook error:` (measured on Claude Code 2.1.318, probe 2 of
// agent-scratch/jo-wolff-plugins/CLAUDE-CODE-DELEGATION-HOOKS-2026-11-04.md) and holds under
// `--dangerously-skip-permissions`.
//
// MODEL  (warn-only, never a deny) a spawn the gates above allow is compared with the routing
//         table (lib/model-routing.json, read through lib/model-routing.mjs): `tool_input.model`
//         above the ceiling for `tool_input.subagent_type` → one additionalContext line naming the
//         type, the model asked for and the ceiling; no `model` on a listed type → one line naming
//         the table's model. A type the table does not list, or a model at or under the ceiling →
//         nothing. A model string naming no family, or an unreadable table → nothing, one
//         skipped.log line. Config `warnModelRouting: false` turns it off. It cannot see the effort
//         level or the model of the session doing the spawning.
//
// ROUTING LOG  every spawn this hook examines (including one it refuses or cannot judge) appends
//         one line to `${XDG_STATE_HOME:-~/.local/state}/delegation/routing.jsonl` (lib/routing-log.mjs:
//         the type, the model set, the table's row, the outcome, the description; never the prompt).
//         A failed write is one errors.log line and changes nothing. Config `logModelRouting: false`
//         turns it off.
//
// NESTED SPAWNS are gated too: a subagent's Agent call fires this hook with `agent_id` set, and
// the brief it writes is held to the same bar. The gate reads the heading only; it does not
// inspect `context`, `description` or anything but `tool_input.prompt` (the model line reads
// `tool_input.model` and `tool_input.subagent_type`, and decides nothing).
//
// UNPARSEABLE: no `tool_input`, a `prompt` that is not a string → allow, one line in
// `${XDG_STATE_HOME:-~/.local/state}/delegation/skipped.log`. `off: true` in the config → null.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. A malformed config → defaults plus a systemMessage naming the file.
// The hooks.json timeout is 5 s, so the runner's 4 s deadline answers before the host kills it.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, logSkipped, withFault } from "../lib/config.mjs";
import { headingReason, isBuilderClass, missingHeadings } from "../lib/brief.mjs";
import { checkReceipt, receiptReason } from "../lib/receipt.mjs";
import { loadTable, routingOutcome, routingWarning } from "../lib/model-routing.mjs";
import { logRouting } from "../lib/routing-log.mjs";

const HOOK = "spawn-gate";
const SPAWN_TOOLS = new Set(["agent", "task"]);

const warn = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  a deny, a systemMessage, or null
 */
export function handle(input, { env = process.env } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off) return null;
  if (!SPAWN_TOOLS.has(String(input?.tool_name ?? "").toLowerCase())) return withFault(null, fault, HOOK);
  const ti = input?.tool_input;
  const record = (outcome, row = null) => {
    if (config.logModelRouting) logRouting(HOOK, { input, toolInput: ti, outcome, row }, env);
  };
  if (!ti || typeof ti !== "object" || typeof ti.prompt !== "string") {
    logSkipped(HOOK, `tool ${input?.tool_name}: tool_input.prompt is not a string; spawn allowed unchecked`, env);
    record("not-checked");
    return withFault(null, fault, HOOK);
  }
  const type = typeof ti.subagent_type === "string" ? ti.subagent_type : undefined;
  const builder = isBuilderClass(type, config.builderClass, config.readOnlyAgents);
  const missing = missingHeadings(ti.prompt, { builder, requireHowItFails: config.requireHowItFails, requireSpiralBound: config.requireSpiralBound });
  if (missing.length) {
    record("not-checked");
    return withFault(deny(headingReason(missing, type, { builder })), fault, HOOK);
  }
  if (builder && config.requirePatternCheck) {
    const receipt = checkReceipt({ sessionId: input.session_id, cwd: input.cwd }, env);
    if (receipt.status === "skipped") logSkipped(HOOK, `pattern-check receipt not checked: ${receipt.why}; spawn allowed`, env);
    else if (receipt.status === "missing") {
      record("not-checked");
      return withFault(deny(receiptReason(type, receipt)), fault, HOOK);
    }
  }
  return withFault(modelLine(ti, type, config, env, record), fault, HOOK);
}

/** The warn-only model line for a spawn the gates allowed, or null. Never a deny. Reports the routing outcome to `record`. */
function modelLine(ti, type, config, env, record) {
  if (!config.warnModelRouting) {
    record("not-checked");
    return null;
  }
  const { table, fault } = loadTable();
  if (!table) {
    logSkipped(HOOK, `model not checked: ${fault}; spawn allowed`, env);
    record("not-checked");
    return null;
  }
  const { warning, skipped } = routingWarning(table, type, ti.model);
  if (skipped) logSkipped(HOOK, `model not checked: ${skipped}; spawn allowed`, env);
  const { row, outcome } = routingOutcome(table, type, ti.model);
  record(outcome, row);
  return warning ? warn(warning) : null;
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
