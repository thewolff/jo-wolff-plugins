#!/usr/bin/env node
// i-have-audhd-prompt.mjs — the next turn hears what the Stop hook warned about.
//
// WHAT THIS IS
//   A UserPromptSubmit hook. The Stop core (hooks/i-have-audhd-stop.mjs) leaves the warn
//   findings of the session's latest checked message in a pending file (lib/pending.mjs).
//   This hook consumes that file when the next prompt arrives and hands it over:
//     additionalContext  the notice, for the agent: which rule, what to move or add, and that
//                        the fix applies from the next message on (the earlier one is sent);
//     systemMessage      one line for the person, naming the rules that fired.
//   Nothing pending → nothing on stdout. The OMP adapter (omp/i-have-audhd-omp.ts) spawns this
//   same file after each stop and delivers the same two fields its own way.
//
// CONTRACT
//   stdin:  the UserPromptSubmit payload; only session_id is read.
//   stdout: {"systemMessage":"…","hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
//           "additionalContext":"…"}} when a notice was pending, {"systemMessage":"…"} alone when
//           this run had a fault, and NOTHING otherwise.
//   Exit 0 on every path; a fault (empty or malformed stdin, an unreadable notice, a throw)
//   leaves one errors.log line and one warning line (lib/state.mjs, FAULTS), and blocks nothing.
//
// KILL SWITCH: the Stop core's flag file ($HOME/.claude/.i-have-audhd-off) silences this hook
// too, per invocation. A pending notice is left in place and delivered once the switch is lifted.

import { existsSync, readFileSync } from "node:fs";
import { killSwitchPath, logFault, faultWarning } from "../lib/state.mjs";
import { takePending } from "../lib/pending.mjs";

const HOOK_FILE = "hooks/i-have-audhd-prompt.mjs";

// Returns the stdout object, {} for silence.
function main() {
  if (existsSync(killSwitchPath())) return {};
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    /* no stdin reads as empty */
  }
  if (!raw.trim()) {
    logFault(HOOK_FILE, "stdin was empty; no UserPromptSubmit payload, no notice delivered");
    return {};
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    logFault(HOOK_FILE, `prompt payload did not parse (${err.message}); no notice delivered`);
    return {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    logFault(HOOK_FILE, "prompt payload is not a JSON object; no notice delivered");
    return {};
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : "no-session";
  const pending = takePending(sessionId);
  if (!pending) return {};
  return {
    // No line for the person when every finding is a judge-unavailable one (lib/pending.mjs).
    ...(pending.summary ? { systemMessage: pending.summary } : {}),
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: pending.notice },
  };
}

let out = {};
try {
  out = main();
} catch (err) {
  logFault(HOOK_FILE, `threw and failed open: ${err?.stack || String(err)}`);
}
const warning = faultWarning(HOOK_FILE);
if (warning) out.systemMessage = out.systemMessage ? `${out.systemMessage}\n${warning}` : warning;
if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
