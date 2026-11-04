#!/usr/bin/env node
// hooks/stop.mjs — brb's Stop hook. Runs under lib/hook-runner.mjs: exit 0 always; a fault is
// one errors.log line and a systemMessage, never a block for its own fault.
//
// What it does: while the session is away (away.json present), hand the final message to
// lib/stop-core.mjs decideStop: new Needs-you lines go to the digest, on-fire lines surface at
// once (systemMessage + OSC 9 terminalSequence + a macOS notification), and the turn is sent
// back to work with `decision: "block"` unless the message ends with an `idle:` line, nothing
// new arrived on a stop-hook continuation, or two stops passed with no tool calls between them.
// Home → null, nothing printed. The whole contract is in stop-core.mjs's header.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log and the stop proceeds. An unreadable
// transcript falls back to comparing messages; an unwritable state directory throws into the
// runner's fail-open path (the ask was in the agent's message on screen; nothing is lost twice).
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
