#!/usr/bin/env node
// hooks/output-types-subagent-stop.mjs - the output-types plugin's SubagentStop hook: the same
// receipts check, judge stage and zero-label rule as hooks/output-types-stop.mjs, run on a
// subagent's report. Runs under lib/hook-runner.mjs: exit 0 always; a fault is one errors.log line
// and a systemMessage, never a deny or a block.
//
// What it does: reads the report the subagent delivered. On Claude Code 2.1.271 or later a
// subagent with the SubagentHandback tool delivers its report as that call's `message` input, and
// last_assistant_message then holds only its closing text, so the handback message in
// agent_transcript_path wins; else last_assistant_message; else the agent transcript's last
// assistant text. Every entry of a subagent transcript is a sidechain entry, so none is dropped.
// It warns the person through systemMessage only. It never feeds anything back to the subagent
// (hookSpecificOutput.additionalContext on SubagentStop keeps the subagent running) and never
// blocks. The zero-label rule has no character floor here (a subagent's report stands in for its
// work); its tool-call floor applies, and it skips Claude Code's internal agents (empty
// agent_type). skipped.log lines name this file.
//
// How it fails: as the Stop hook (its header says how): stdin not JSON, a thrown error or no answer
// at the deadline → the runner logs it to ${XDG_STATE_HOME:-~/.local/state}/output-types/errors.log
// and allows. A missing agent transcript falls back to last_assistant_message and skips the
// zero-label rule (no tool count). OUTPUT_TYPES_CHECK=off → no output at all.

import { DEADLINE_MS, invokedDirectly, runHook } from "../lib/hook-runner.mjs";
import { judgeEnabled } from "../lib/receipts.mjs";
import { JUDGE_DEADLINE_MS } from "./output-types-stop.mjs";

// The runner's worker imports this module and calls its handle(); the handler is shared with Stop
// and reads hook_event_name to pick the report and transcript.
export { handle } from "./output-types-stop.mjs";

if (invokedDirectly(import.meta.url)) {
  const deadlineMs = Number(process.env.OUTPUT_TYPES_STOP_DEADLINE_MS) || (judgeEnabled(process.env) ? JUDGE_DEADLINE_MS : DEADLINE_MS);
  runHook("SubagentStop", import.meta.url, { plugin: "output-types", quiet: false, deadlineMs });
}
