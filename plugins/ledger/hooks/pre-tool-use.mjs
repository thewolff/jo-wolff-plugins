#!/usr/bin/env node
// pre-tool-use.mjs — PreToolUse: deny AskUserQuestion while no ledger question is open for
// the folder, so every question the human is asked has a row they can answer by typing.
//
// Input read: tool_name, cwd (hooks reference § PreToolUse input, § Common input fields).
// hooks.json spawns this for AskUserQuestion only.
//
// Output on deny: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":
// "deny","permissionDecisionReason":"…"}}, exit 0. On pass: nothing. The reason names the
// `ledger ask …` that lifts the denial.
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
    const verdict = evaluate(input, { db: store.db, config: store.config, cwd, cli: invocation() });
    if (!verdict) return store.notices.length ? noticeField(store.notices) : null;
    // A deny tells the agent to run `ledger ask`, which writes. When the store cannot take a write
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
