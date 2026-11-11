#!/usr/bin/env node
// hooks/stop.mjs — the continuity plugin's Stop hook. Runs under lib/hook-runner.mjs: exit 0
// always; a fault is one errors.log line and a systemMessage, never a block.
//
// What it does: when lib/pressure.mjs dueAsk() says an ask is due for this surface (the context
// size, from the token usage the last reply recorded in the transcript or, with none, the
// transcript's bytes since its last compaction marker through a calibrated ratio or / 8, has
// reached the ask point: default 175,000 tokens and at least 40,000 past the compaction window's
// first recorded usage; or, after a block or a handoff this session wrote, a further 150,000
// tokens in the same window; a compaction re-arms it), and no handoff carrying this session's id
// was written in `.ai/handoffs/` since the window's compaction and the last block, it blocks the
// stop (`decision: "block"`) and hands the model one more turn to run `/continuity:handoff`. Why
// Stop: it is the only event that can hand the model a turn, and PreCompact fires at the cliff,
// not the approach.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows (a Stop hook that blocks and then throws would trap the person in a
// session they cannot end, which is worse than never nudging). No measurable transcript, a
// context under the point due, a handoff already written this window, or `stop_hook_active`
// already true → silent. The anchor is written before the block is given: an anchor that cannot
// be written means no block at all, so the person can always end the session. `"pressure":
// "off"` in `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json` turns it off.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { readConfig } from "../lib/config.mjs";
import { dueAsk, handoffRequest } from "../lib/pressure.mjs";
import { readFlags, sessionKey } from "../lib/session-flags.mjs";

export async function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "Stop") return null;
  const { config } = readConfig(env);
  if (config.pressure === "off" || input.stop_hook_active === true) return null;
  const ask = await dueAsk(input, "stopBlocked", { config, flags: readFlags(sessionKey(input), env), env });
  if (!ask || !ask.mark()) return null;
  // The block reason names the way out, `/continuity:handoff`, and the one-line alternative.
  return { decision: "block", reason: handoffRequest(ask.tokens, ask.basis, ask.next) };
}

if (invokedDirectly(import.meta.url)) runHook("Stop", import.meta.url, { plugin: "continuity", quiet: false });
