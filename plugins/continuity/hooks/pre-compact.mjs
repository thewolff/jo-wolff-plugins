#!/usr/bin/env node
// hooks/pre-compact.mjs — the continuity plugin's PreCompact hook. Runs under lib/hook-runner.mjs:
// exit 0 always; a fault is one errors.log line, never a block.
//
// What it does: saves the session's deterministic state (branch, uncommitted paths, files
// touched, recent asks, open handoffs) to `${XDG_STATE_HOME:-~/.local/state}/continuity/
// <session>.json`, which hooks/session-start.mjs injects back after the compaction. Every
// invocation leaves two heartbeat records (`started`, then `ok` or `failed:<reason>`) that the
// liveness line reads. When the payload carries a real `token_count` (a host adapter that passes
// one; Claude Code's PreCompact payload does not), it also leaves one calibration record that
// sharpens the context-pressure byte estimate for a transcript with no recorded usage.
//
// What it prints, on Claude Code: SUMMARY_INSTRUCTIONS as plain text, on every compaction
// (auto, idle, manual), whether or not the save is switched on. Claude Code uses a PreCompact
// hook's plain stdout as instructions for the compaction summary and discards its
// `systemMessage` (code.claude.com/docs/en/hooks.md, "PreCompact" and "PreCompact output"), so
// the text asks the summary to end with a `## Handoff` section: the judgment layer survives the
// compaction even when no handoff file was written. The text is fixed: nothing from the
// transcript or the payload is put into it. The notices this hook used to give as a
// systemMessage go elsewhere there: a save that failed is in errors.log, the heartbeat and the
// post-compaction restore's "not restored" line; a compaction with no handoff file is said by
// hooks/session-start.mjs after it; a config problem by the next hook that can be heard.
//
// Under OMP (the adapter sets CONTINUITY_HOST=omp; lib/config.mjs onOmp()) it answers JSON as
// before: a `systemMessage` the adapter shows with ctx.ui.notify for a save that failed, a
// config problem, or an auto-compaction with no handoff written, and nothing otherwise. OMP gets
// no summary instructions: the adapter never replaces OMP's summary.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// errors.log and prints its own `{ systemMessage }` JSON (on Claude Code the summary then gets no
// instructions from this hook); compaction proceeds. A snapshot that cannot be written is
// `failed:<code>` in the heartbeat and errors.log, and compaction still proceeds. Every git
// call runs at once inside one 2 s budget (lib/snapshot.mjs GIT_BUDGET_MS), so on a slow checkout
// the snapshot is still written inside the deadline, with each field git did not answer saved as
// `(unknown: timed out)`. `"snapshot": "off"` in `${XDG_CONFIG_HOME:-~/.config}/continuity/
// config.json` records `skipped:off` and saves nothing.
//
// handle() runs on a worker thread: it returns a string, a plain object or null (or a promise of
// one), never writes stdout or exits, and passes input.cwd to every subprocess.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { recordCalibration } from "../lib/calibration.mjs";
import { onOmp, readConfig } from "../lib/config.mjs";
import { logError } from "../lib/errors.mjs";
import { recordHeartbeat } from "../lib/heartbeat.mjs";
import { stateDir } from "../lib/paths.mjs";
import { markFlag, readFlags, sessionKey } from "../lib/session-flags.mjs";
import { capture } from "../lib/snapshot.mjs";

/** The compaction-summary instructions printed on Claude Code. Fixed text, under Claude Code's 10,000-character cap. */
export const SUMMARY_INSTRUCTIONS = [
  "Instructions from the continuity plugin for this compaction summary:",
  "",
  "End the summary with a section headed exactly `## Handoff`, written for whoever continues from this summary with nothing else to go on. Under it, four short labelled parts, each from what the conversation actually shows:",
  "",
  "- In flight: what was being worked on when the compaction began, how far it got, and what state the files, branch and any running work were left in.",
  "- Ruled out: approaches tried or considered and rejected, each with the reason, so they are not tried again.",
  "- Still open: questions not yet answered, decisions still waiting on the person, and anything uncertain or unverified.",
  "- Next step: the single next action, specific enough to start on without rereading anything.",
  "",
  "Write \"none\" for a part the conversation gives nothing for; do not invent content to fill it. Keep exact file paths, commands, identifiers and error text. If a handoff file was written under `.ai/handoffs/` in this session, name its path in the section.",
].join("\n");

export async function handle(input, { env = process.env } = {}) {
  if (input?.hook_event_name !== "PreCompact") return null;
  const omp = onOmp(env);
  const beat = { event: "PreCompact", trigger: input.trigger, session: input.session_id, cwd: input.cwd };
  const { config, problem } = readConfig(env);
  const notes = [];
  const key = sessionKey(input);
  // Only OMP shows this hook's notices; on Claude Code the config problem waits for a hook whose
  // message is heard, so it is not marked said here.
  if (omp && problem && !readFlags(key, env).configNoted) {
    notes.push(`continuity: ${problem}.`);
    markFlag(key, "configNoted", env);
  }
  const answer = () => (omp ? (notes.length ? { systemMessage: notes.join(" ") } : null) : SUMMARY_INSTRUCTIONS);
  if (config.snapshot === "off") {
    recordHeartbeat({ ...beat, outcome: "skipped:off" }, env);
    return answer();
  }
  const beating = recordHeartbeat({ ...beat, outcome: "started" }, env);
  const { outcome, snapshot, path } = await capture(input, { env });
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
  // is about to be lost and only the person can act on that. On Claude Code,
  // hooks/session-start.mjs says it after the compaction instead.
  else if (String(input.trigger || "") === "auto" && snapshot && !snapshot.handoff.present && !snapshot.hostJudgment) {
    notes.push(
      "continuity: auto-compaction fired with no handoff written, so the judgment layer of this session (what was attempted, what was ruled out, what is still open) was not captured; only mechanical state survives. " +
      "Before deep sessions in future, say \"hand off\" or run `/continuity:handoff` so the next window inherits it.",
    );
  }
  return answer();
}

if (invokedDirectly(import.meta.url)) runHook("PreCompact", import.meta.url, { plugin: "continuity", quiet: false });
