#!/usr/bin/env node
// hooks/user-prompt-submit.mjs — reminders-review's UserPromptSubmit hook. Runs under
// lib/hook-runner.mjs: exit 0 always, never a block.
//
// What it does: at most once an hour per session (the stamp SessionStart also writes,
// lib/due.mjs WHEN), the same check as SessionStart, returned as additionalContext on this
// prompt. Within the hour, nothing watched, or nothing due → nothing. A remindctl fault is one
// errors.log line and silence: the SessionStart line already named the fix.

import { runHook, invokedDirectly } from "../lib/hook-runner.mjs";
import { dueCheck } from "../lib/due.mjs";

export function handle(input, deps = {}) {
  return dueCheck("UserPromptSubmit", input, deps);
}

if (invokedDirectly(import.meta.url)) runHook("UserPromptSubmit", import.meta.url, { plugin: "reminders-review" });
