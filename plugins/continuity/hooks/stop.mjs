#!/usr/bin/env node
// hooks/stop.mjs — the continuity plugin's Stop hook. Runs under lib/hook-runner.mjs: exit 0
// always; a fault is one errors.log line and a systemMessage, never a block.
//
// What it does: once per session, when the context size (lib/pressure.mjs: the token usage the
// last reply recorded in the transcript, or, with none, the transcript's bytes since its last
// compaction marker through a calibrated ratio or / 8) is at or past
// `threshold` (default 0.65) of `contextTokens` (default 200000), and no handoff carrying this
// session's id is open in the repository's `.ai/handoffs/`, it blocks the stop
// (`decision: "block"`) and hands the model one more turn to run `/continuity:handoff`. Why Stop:
// it is the only event that can hand the model a turn, and PreCompact fires at the cliff, not the
// approach.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows (a Stop hook that blocks and then throws would trap the person in a
// session they cannot end, which is worse than never nudging). No measurable transcript, an
// estimate under the threshold, a handoff already written this session, `stop_hook_active`
// already true, or the session already blocked once → silent. The once-mark is written before
// the block is given: a mark that cannot be written means no block at all, so the person can
// always end the session. `"pressure": "off"` in
// `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json` turns it off.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { handoffWrittenBy, resolveHandoffRoot } from "../lib/handoffs.mjs";
import { handoffRequest, pressure } from "../lib/pressure.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";

export async function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "Stop") return null;
  const { config } = readConfig(env);
  if (config.pressure === "off" || input.stop_hook_active === true) return null;
  const key = sessionKey(input);
  if (readFlags(key, env).stopBlocked) return null;
  const p = pressure(input, { threshold: config.threshold, contextTokens: config.contextTokens, env });
  if (!p) return null;
  // The handoff the block would ask for is already written: one more turn would only repeat it.
  const { root } = await resolveHandoffRoot(String(input.cwd || "") || process.cwd(), env);
  if (handoffWrittenBy(root, input.session_id)) return null;
  if (!markFlag(key, "stopBlocked", env)) return null;
  // The block reason names the way out, `/continuity:handoff`, and the one-line alternative.
  return { decision: "block", reason: handoffRequest(p.pct, p.basis) };
}

if (invokedDirectly(import.meta.url)) runHook("Stop", import.meta.url, { plugin: "continuity", quiet: false });
