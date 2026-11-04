#!/usr/bin/env node
// pre-tool-use.mjs — PreToolUse: deny AskUserQuestion while no ledger question is open for
// the folder, and deny a Bash `git push` / `gh pr create` while the session has no note.
//
// Input read: tool_name, tool_input.command, session_id, cwd (hooks reference § PreToolUse
// input, § Common input fields). hooks.json spawns this for AskUserQuestion and Bash only.
//
// Output on deny: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":
// "deny","permissionDecisionReason":"…"}}, exit 0. On pass: nothing. The reason names the
// `ledger ask …` or `ledger note …` that lifts the denial.
//
// Fail open: switch off → nothing; store busy/unavailable → allow with one systemMessage line;
// anything thrown → runHook's systemMessage. Never exit 2.

import { runHook, noticeField, invokedDirectly } from "../lib/failopen.mjs";
import { evaluate } from "../lib/gate.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { assertWritable } from "../lib/db.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "preToolUse");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg }, "the ledger gate is not enforced for this call", (store) => {
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const verdict = evaluate(input, { db: store.db, config: store.config, cwd, cli: invocation(), sessionId });
    if (!verdict) return store.notices.length ? noticeField(store.notices) : null;
    // A deny tells the agent to run `ledger ask` or `ledger note`, which write. When the store cannot take a write
    // (read-only file, a lock that outlasts busy_timeout) that advice is a dead end, so the gate
    // passes instead; withStore turns the StoreError into the allow shape with one systemMessage.
    assertWritable(store.db, store.dbPath);
    return {
      ...noticeField(store.notices),
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason },
    };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("PreToolUse", (input) => handle(input));
}
