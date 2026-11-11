#!/usr/bin/env node
// hooks/session-brief-gate.mjs — PreToolUse on `mcp__ccd_session__start_session`, the desktop
// app's tool that starts (or offers) a new session. Runs under lib/hook-runner.mjs: exit 0
// always; a fault is one errors.log line and a systemMessage, never a deny.
//
// THE GATE  `tool_input.prompt` lacks any of the five heading lines Target, Change, Acceptance,
//           How it fails, Spiral bound (lib/brief.mjs missingSessionHeadings, the same literal
//           heading match as the spawn gate) → deny, naming the missing headings and carrying
//           each missing section in full (sessionHeadingReason). Config
//           `checks["session-brief-gate"]`: `block` (default) denies, `warn` allows with one
//           additionalContext line (sessionHeadingWarning), `off` is silence.
//
// SILENT    all five present; `proposal_id` with no `prompt` (starting a card already offered:
//           the brief was judged when the card was offered); `off: true`.
// UNPARSEABLE  no `tool_input`, or a `prompt` that is missing or not a string → allow, one line
//           in `${XDG_STATE_HOME:-~/.local/state}/delegation/skipped.log`.
//
// Measured in the desktop app on 2026-11-11 (a hook-input capture): PreToolUse fires for this
// tool, `tool_input` carries background, context, initiation, prompt and title, `prompt` is a
// string, and after a deny the model issued the call again. It reads only `off` and this one
// `checks` entry; `requireHowItFails` belongs to the spawn gate.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows. A malformed config → defaults plus a systemMessage naming the file.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { loadConfig, logSkipped, withFault } from "../lib/config.mjs";
import { missingSessionHeadings, sessionHeadingReason, sessionHeadingWarning, START_SESSION_TOOL } from "../lib/brief.mjs";

const HOOK = "session-brief-gate";

const warn = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/**
 * @param {object} input  the host's JSON for this event
 * @returns {object|null}  a deny, an additionalContext line, a systemMessage, or null
 */
export function handle(input, { env = process.env } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off) return null;
  const mode = config.checks[HOOK];
  if (mode === "off" || input?.tool_name !== START_SESSION_TOOL) return withFault(null, fault, HOOK);
  const ti = input?.tool_input;
  if (ti && typeof ti === "object" && ti.prompt === undefined && ti.proposal_id !== undefined) return withFault(null, fault, HOOK);
  if (!ti || typeof ti !== "object" || typeof ti.prompt !== "string") {
    logSkipped(HOOK, `tool ${input?.tool_name}: tool_input.prompt is not a string; session start allowed unchecked`, env);
    return withFault(null, fault, HOOK);
  }
  const missing = missingSessionHeadings(ti.prompt);
  if (!missing.length) return withFault(null, fault, HOOK);
  return withFault(mode === "warn" ? warn(sessionHeadingWarning(missing)) : deny(sessionHeadingReason(missing)), fault, HOOK);
}

if (invokedDirectly(import.meta.url)) runHook(HOOK, import.meta.url, { plugin: "delegation" });
