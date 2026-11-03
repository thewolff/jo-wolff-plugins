#!/usr/bin/env node
// session-start.mjs — SessionStart: record the session, inject the folder's open state.
//
// Input read: session_id, cwd, source (hooks reference § SessionStart input).
// Output: hookSpecificOutput.additionalContext with, in order and only when non-empty: open
// questions (the `pending` block), open workloads, the last N decisions, the no-open-workload
// line, the verb summary. On `source: compact` only questions, workloads and the gate line.
//
// Fail open: config switch off → exit 0 before the store is touched; store busy or unavailable →
// no injection and one systemMessage line; anything thrown → runHook's systemMessage.

import { loadConfig } from "../lib/config.mjs";
import { StoreError, transaction } from "../lib/db.mjs";
import { runHook, noticeField, invokedDirectly } from "../lib/failopen.mjs";
import { buildInjection } from "../lib/inject.mjs";
import { withStore, resolveCwd } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const cfg = loadConfig({ env });
  if (!cfg.config.hooks.sessionStart) return null;
  return withStore({ env, now, notices: cfg.notices }, "no injection this session", (store) => {
    const cwd = resolveCwd(env, input.cwd);
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const notices = [...store.notices];
    if (sessionId) {
      // Best effort: the injection is read-only and still worth having when a writer holds the lock.
      try {
        transaction(
          store.db,
          () => {
            store.db
              .prepare("INSERT INTO sessions (id, cwd, started_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, ended_at = NULL, end_reason = NULL")
              .run(sessionId, cwd, nowIso(now));
          },
          store.dbPath,
        );
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        notices.push(`ledger: database busy at ${err.path}; this session was not recorded (the Stop hook will)`);
      }
    }
    const { text } = buildInjection(store.db, cwd, store.config, { source: input.source, now });
    return {
      ...noticeField(notices),
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("SessionStart", (input) => handle(input));
}
