#!/usr/bin/env node
// pre-tool-use.mjs — PreToolUse: deny pushes, PR creation, writes outside the folder, and
// AskUserQuestion without a question row, until a workload is open for the folder.
//
// Input read: tool_name, tool_input (command / file_path / notebook_path), cwd, scratchpad_dir
// (hooks reference § PreToolUse input, § Common input fields). hooks.json spawns this for Bash
// (with `if: Bash(git *)` and `Bash(gh *)` as spawn savers only; the rules re-parse the
// command themselves), for Write|Edit|MultiEdit|NotebookEdit, and for AskUserQuestion.
//
// Output on deny: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":
// "deny","permissionDecisionReason":"…"}}, exit 0. On pass: nothing. The reason always names
// the `ledger open …` that lifts the denial.
//
// Fail open: switch off → nothing; store busy/unavailable → allow with one systemMessage line;
// anything thrown → runHook's systemMessage. Never exit 2.

import { loadConfig } from "../lib/config.mjs";
import { runHook, noticeField, invokedDirectly } from "../lib/failopen.mjs";
import { evaluate } from "../lib/gate.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, resolveCwd } from "../lib/store.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const cfg = loadConfig({ env });
  if (!cfg.config.hooks.preToolUse) return null;
  return withStore({ env, now, notices: cfg.notices }, "the ledger gate is not enforced for this call", (store) => {
    const cwd = resolveCwd(env, input.cwd);
    const verdict = evaluate(input, { db: store.db, config: store.config, cwd, cli: invocation() });
    if (!verdict) return store.notices.length ? noticeField(store.notices) : null;
    return {
      ...noticeField(store.notices),
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason },
    };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("PreToolUse", (input) => handle(input));
}
