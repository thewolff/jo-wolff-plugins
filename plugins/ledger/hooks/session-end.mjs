#!/usr/bin/env node
// session-end.mjs — SessionEnd: record that the session ended. Input read: session_id, reason
// (hooks reference § SessionEnd input). One UPDATE on the sessions row, then the session's bounce
// rows still open become `bypassed` (a separate, fail-open write). Open questions stay open
// until answered or withdrawn.
//
// Budget: SessionEnd hooks share a 1.5-second budget that a plugin cannot raise, so this does
// the least possible. SessionEnd discards JSON output, so failures go to errors.log only.
// Exit 0 always.

import { StoreError, transaction } from "../lib/db.mjs";
import { runHook, logError, invokedDirectly } from "../lib/failopen.mjs";
import { openStore, hookConfig } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { bypassBounces } from "../lib/bounces.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "sessionEnd");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  for (const n of cfg.notices) logError("SessionEnd", n, env);
  const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
  if (!sessionId) return null;
  let store;
  try {
    store = openStore({ env, now, cwd, cfg });
  } catch (err) {
    if (err instanceof StoreError) {
      logError("SessionEnd", err.message, env);
      return null;
    }
    throw err;
  }
  try {
    for (const n of store.notices) logError("SessionEnd", n, env);
    const reason = typeof input.reason === "string" && input.reason ? input.reason : "other";
    const iso = nowIso(now);
    transaction(
      store.db,
      () => {
        store.db
          .prepare("INSERT INTO cc_sessions (id, cwd, started_at, ended_at, end_reason) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, end_reason = excluded.end_reason")
          .run(sessionId, cwd, iso, iso, reason);
      },
      store.dbPath,
    );
    bypassBounces(store, { sessionId, env });
    return { ended: sessionId };
  } finally {
    store.db.close();
  }
}

if (invokedDirectly(import.meta.url)) {
  // Output is discarded by Claude Code for this event; return nothing so stdout stays empty.
  runHook("SessionEnd", (input) => (handle(input), null), { quiet: true });
}
