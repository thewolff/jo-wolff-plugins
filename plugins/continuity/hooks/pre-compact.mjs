#!/usr/bin/env node
// hooks/pre-compact.mjs — the continuity plugin's PreCompact hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line and a systemMessage, never a block.
//
// What it does: saves the session's deterministic state (branch, uncommitted paths, files
// touched, recent asks, open handoffs) to `${XDG_STATE_HOME:-~/.local/state}/continuity/
// <session>.json`, which hooks/session-start.mjs injects back after the compaction. Every
// invocation leaves two heartbeat records (`started`, then `ok` or `failed:<reason>`) that the
// liveness line reads, and one calibration record (transcript bytes against the payload's
// `token_count`) that the context-pressure check reads. When auto-compaction fires with no
// handoff written, it says so in a `systemMessage`: the person sees it, the model does not
// (PreCompact cannot inject context, and no hook gives the model a turn before auto-compaction).
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and allows; compaction proceeds. A snapshot that cannot be written is
// `failed:<code>` in the heartbeat and in the message, and compaction still proceeds. Each git
// command has its own 800 ms timeout and an unreadable transcript is a named absence in the
// file, so the save fits inside the deadline on a slow checkout. `"snapshot": "off"` in
// `${XDG_CONFIG_HOME:-~/.config}/continuity/config.json` records `skipped:off` and does nothing else.
// A heartbeat or snapshot that cannot be written is one errors.log line and a systemMessage.
//
// handle() runs on a worker thread: it returns a plain object or null, never writes stdout or
// exits, and passes input.cwd to every subprocess.

import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { recordCalibration } from "../lib/calibration.mjs";
import { readConfig } from "../lib/config.mjs";
import { recordHeartbeat } from "../lib/heartbeat.mjs";
import { stateDir } from "../lib/paths.mjs";
import { capture } from "../lib/snapshot.mjs";

export function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "PreCompact") return null;
  const beat = { event: "PreCompact", trigger: input.trigger, session: input.session_id, cwd: input.cwd };
  const { config, problem } = readConfig(env);
  const notes = problem ? [`continuity: ${problem}.`] : [];
  if (config.snapshot === "off") {
    recordHeartbeat({ ...beat, outcome: "skipped:off" }, env);
    return notes.length ? { systemMessage: notes.join(" ") } : null;
  }
  const beating = recordHeartbeat({ ...beat, outcome: "started" }, env);
  const { outcome, snapshot, path } = capture(input, { env });
  recordHeartbeat({ ...beat, outcome }, env);
  recordCalibration(input, env);
  // A state write that failed is logged where the runner logs its own faults, so the gate's
  // "failures visible" rule and the person's `errors.log` both see it.
  if (!beating) {
    logError("continuity", "PreCompact", `heartbeat could not be written under ${stateDir(env)}; the liveness line will not see this save`, env);
    notes.push(`continuity: the heartbeat record could not be written under ${stateDir(env)}, so the liveness line will not count this save.`);
  }
  if (outcome !== "ok") {
    logError("continuity", "PreCompact", `snapshot not written to ${path} (${outcome})`, env);
    notes.push(`continuity: the pre-compaction snapshot could not be written to ${path} (${outcome}); compaction proceeds without it.`);
  }
  // Auto-compaction arriving with no handoff is the case worth surfacing: the judgment layer
  // is about to be lost and only the person can act on that.
  else if (String(input.trigger || "") === "auto" && snapshot && !snapshot.handoff.present && !snapshot.hostJudgment) {
    notes.push(
      "continuity: auto-compaction fired with no handoff written, so the judgment layer of this session (what was attempted, what was ruled out, what is still open) was not captured; only mechanical state survives. " +
      "Before deep sessions in future, say \"hand off\" or run `/continuity:handoff` so the next window inherits it.",
    );
  }
  return notes.length ? { systemMessage: notes.join(" ") } : null;
}

if (invokedDirectly(import.meta.url)) runHook("PreCompact", import.meta.url, { plugin: "continuity", quiet: false });
