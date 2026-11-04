#!/usr/bin/env node
// hooks/stop.mjs — the continuity plugin's Stop hook. Runs under lib/hook-runner.mjs: exit 0
// always; a fault is one errors.log line and a systemMessage, never a block.
//
// What it does: once per session, when the transcript's size against the machine's calibration
// puts the session at or past `threshold` (default 0.65) of the compaction target, it blocks the
// stop (`decision: "block"`) and hands the model one more turn to run `/continuity:handoff`. Why
// Stop: PreCompact is the only event carrying `token_count`, but it fires at compaction, the
// cliff, not the approach; Stop is the only event that can hand the model a turn.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows (a Stop hook that blocks and then throws would trap the person in a
// session they cannot end, which is worse than never nudging). No calibration, no measurable
// transcript, `stop_hook_active` already true, or the session already blocked once → silent.
// The once-mark is written before the block is given: a mark that cannot be written means no
// block at all, so the person can always end the session. `"pressure": "off"` in
// `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json` turns it off.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { handoffRequest, pressure } from "../lib/pressure.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";

export function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "Stop") return null;
  const { config } = readConfig(env);
  if (config.pressure === "off" || input.stop_hook_active === true) return null;
  const key = sessionKey(input);
  if (readFlags(key, env).stopBlocked) return null;
  const p = pressure(input, { threshold: config.threshold, env });
  if (!p) return null;
  if (!markFlag(key, "stopBlocked", env)) return null;
  // The block reason names the way out, `/continuity:handoff`, and the one-line alternative.
  return { decision: "block", reason: handoffRequest(p.pct) };
}

if (invokedDirectly(import.meta.url)) runHook("Stop", import.meta.url, { plugin: "continuity", quiet: false });
