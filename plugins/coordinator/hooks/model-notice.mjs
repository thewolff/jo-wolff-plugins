#!/usr/bin/env node
// hooks/model-notice.mjs — the coordinator plugin's PostModelSwitch hook. Runs under
// lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line and a systemMessage, never a
// deny or block (PostModelSwitch cannot block anyway).
//
// What it does: when the session's cwd is inside a folder listed in the config's `folders`, a
// switch onto a model below `expectedModel` (a minimum) adds one additionalContext line naming the
// model and the owner's setting, and a switch from such a model, or from one that cannot be judged
// (an alias), back onto at least `expectedModel` adds one line saying the earlier notice no longer applies. Text and matching rules: lib/model-notice.mjs.
//
// Only PostModelSwitch: SessionStart input carries no model on the desktop app or the CLI
// (measured 2026-11-11), so the starting model stays the first reply's job (the skill's "Model
// check"). Silent on `source: "resume"`, on an empty folder list, and outside every folder. An
// alias, or a family not in `modelFamilyRank`, is not judged: one skipped.log line.
//
// How it fails: stdin not JSON, a thrown error, or no answer in 4 s → the runner logs it to
// ${XDG_STATE_HOME:-~/.local/state}/coordinator/errors.log and allows. A malformed config → the
// defaults (folders empty, so silent) plus a systemMessage naming the file. A model that cannot be judged
// whose skipped.log line cannot be written → a systemMessage naming the file (and an errors.log
// line when that can be written).

import { runHook, invokedDirectly, logError } from "../lib/hook-runner.mjs";
import { loadConfig, logSkipped, withFault } from "../lib/config.mjs";
import { decide } from "../lib/model-notice.mjs";

const HOOK = "model-notice";

/**
 * @param {object} input  the PostModelSwitch payload; to_model, from_model, source, cwd and, when present, effort.level are read
 * @returns {object|null}  an additionalContext, a systemMessage, or null
 */
export function handle(input, { env = process.env } = {}) {
  const { config, fault } = loadConfig(env);
  if (config.off) return null;
  if (input?.hook_event_name !== "PostModelSwitch") return withFault(null, fault, HOOK);
  const effort = typeof input.effort?.level === "string" ? input.effort.level : undefined;
  const { say, skipped } = decide({ cwd: input.cwd, toModel: input.to_model, fromModel: input.from_model, source: input.source, effort }, config);
  const lost = skipped ? logSkipped(HOOK, skipped, env) : null;
  if (lost) logError("coordinator", "PostModelSwitch", `${HOOK}: ${lost}`, env);
  const out = withFault(say ? { hookSpecificOutput: { hookEventName: "PostModelSwitch", additionalContext: say } } : null, fault, HOOK);
  if (!lost) return out;
  const note = `coordinator ${HOOK}: ${lost}`;
  return { ...out, systemMessage: out?.systemMessage ? `${out.systemMessage}\n${note}` : note };
}

if (invokedDirectly(import.meta.url)) runHook("PostModelSwitch", import.meta.url, { plugin: "coordinator" });
