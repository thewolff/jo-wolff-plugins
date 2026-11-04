#!/usr/bin/env node
// test/fixtures/big-answer-hook.mjs — a hook for the runner's output tests only (test/limits.test.mjs).
// It answers SessionStart with an additionalContext of `input.bytes` "x" characters, through the
// plugin's own lib/hook-runner.mjs, so the runner's stdout write is exercised with answers larger
// than a pipe buffer. HOOK_DEADLINE_MS overrides the runner's 4 s deadline.

import { runHook, invokedDirectly } from "../../lib/hook-runner.mjs";

export function handle(input) {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "x".repeat(Number(input.bytes) || 0) } };
}

if (invokedDirectly(import.meta.url)) runHook("SessionStart", import.meta.url, { plugin: "reminders-review", deadlineMs: Number(process.env.HOOK_DEADLINE_MS) || undefined });
