#!/usr/bin/env node
// hooks/stop.mjs — brb's Stop hook. Runs under lib/hook-runner.mjs: exit 0 always; a fault is
// one errors.log line and a systemMessage, never a block for its own fault.
//
// What it does: while the session is away (away.json present), hand the final message to
// lib/stop-core.mjs decideStop: new Needs-you lines and a closing ask go to the digest (once;
// an item the agent already held with scripts/brb.mjs is not filed twice), on-fire lines
// surface at once (systemMessage + OSC 9 terminalSequence + a macOS notification), a message
// that showed an ask at all is blocked once per turn (`decision: "block"`, the backstop: the
// agent replies again with the body only), and otherwise the agent is sent back to work
// (hookSpecificOutput.additionalContext on Claude Code, `decision: "block"` under
// BRB_HARNESS=omp) unless an `idle:` line is among the message's last five non-blank lines, a
// tool-less stop-hook continuation brought nothing new, or two stops passed with no tool calls
// between them. Home → null, nothing printed. The whole contract is in stop-core.mjs's header.
//
// The band's Back button (mods/band) cannot run a hook, so it leaves a `back-requested` marker
// in the session directory. A stop that finds the marker while away ends the hold first, as
// `back` does (lib/back.mjs endHold: archive, checklist.json for the band, away.json cleared),
// and blocks this stop once with the back instruction and the digest as the reason, so the
// agent's next reply is the digest, the same as after `back` typed; the archive line and the
// digest ride a systemMessage too. The message that was stopping is not filed: Jo is back and
// reads it. A marker with no hold is removed and the stop goes on as home.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/brb/errors.log and the stop proceeds. An unreadable
// transcript counts every stop-hook continuation as tool-less. An unwritable state directory is
// one errors.log line and a systemMessage; an on-fire line in the same message still surfaces.
//
// OMP spawns this same file with BRB_HARNESS=omp (omp/brb-omp.ts) and reads the same JSON.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { endHold } from "../lib/back.mjs";
import { backRequested } from "../lib/state.mjs";
import { decideStop } from "../lib/stop-core.mjs";

/**
 * @param {object} input  the Stop payload
 * @returns {object|null}
 */
export function handle(input, { env = process.env, now = () => new Date().toISOString() } = {}) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (backRequested(sessionId, env)) {
    const ended = endHold(sessionId, env, now());
    if (ended) return { decision: "block", reason: ended.agentText, systemMessage: ended.text };
  }
  return decideStop(input, { env });
}

if (invokedDirectly(import.meta.url)) runHook("Stop", import.meta.url, { plugin: "brb", quiet: false });
