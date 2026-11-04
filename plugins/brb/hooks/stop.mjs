#!/usr/bin/env node
// hooks/stop.mjs — brb's Stop hook. Runs under lib/hook-runner.mjs: exit 0 always; a fault is
// one errors.log line and a systemMessage, never a block for its own fault.
//
// What it does: while the session is away (away.json present), hand the final message to
// lib/stop-core.mjs decideStop: new Needs-you lines go to the digest, on-fire lines surface at
// once (systemMessage + OSC 9 terminalSequence + a macOS notification), and the agent is sent
// back to work (hookSpecificOutput.additionalContext on Claude Code, `decision: "block"` under
// BRB_HARNESS=omp) unless an `idle:` line is among the message's last five non-blank lines, a
// tool-less stop-hook continuation brought nothing new, or two stops passed with no tool calls
// between them. Home → null, nothing printed. The whole contract is in stop-core.mjs's header.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log and the stop proceeds. An unreadable
// transcript counts every stop-hook continuation as tool-less. An unwritable state directory is
// one errors.log line and a systemMessage; an on-fire line in the same message still surfaces.
//
// OMP spawns this same file with BRB_HARNESS=omp (omp/brb-omp.ts) and reads the same JSON.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { decideStop } from "../lib/stop-core.mjs";

/**
 * @param {object} input  the Stop payload
 * @returns {object|null}
 */
export function handle(input, { env = process.env } = {}) {
  return decideStop(input, { env });
}

if (invokedDirectly(import.meta.url)) runHook("Stop", import.meta.url, { plugin: "brb", quiet: false });
