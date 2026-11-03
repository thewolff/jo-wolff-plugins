#!/usr/bin/env node
// session-end.mjs — SessionEnd: park this session's open workloads so nothing is left open
// silently. Input read: session_id, cwd, reason (hooks reference § SessionEnd input).
//
// One transaction: every `open` workload whose session_id is this session, or whose cwd governs
// the hook cwd and that no session has claimed, becomes `parked` with status_reason
// "session ended (<reason>)", status_by "hook:SessionEnd", plus one `park` decision row each.
// Never closes: a close needs a reason from a person or the agent. The next SessionStart
// offers `ledger open wl-…`.
//
// Budget: SessionEnd hooks share a 1.5-second budget that a plugin cannot raise, so this does
// the least possible: no injection text, no config beyond the switch and the path. The Stop
// hook stamps last_seen_at every turn, so `stale` stays right even when this is cut off.
//
// SessionEnd discards JSON output, so failures go to errors.log only. Exit 0 always.

import { loadConfig } from "../lib/config.mjs";
import { StoreError, transaction } from "../lib/db.mjs";
import { runHook, logError, invokedDirectly } from "../lib/failopen.mjs";
import { isWithin } from "../lib/commands.mjs";
import { newId } from "../lib/ids.mjs";
import { openStore, resolveCwd } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const cfg = loadConfig({ env });
  if (!cfg.config.hooks.sessionEnd) return null;
  for (const n of cfg.notices) logError("SessionEnd", n, env);
  let store;
  try {
    store = openStore({ env, now });
  } catch (err) {
    if (err instanceof StoreError) {
      logError("SessionEnd", err.message, env);
      return null;
    }
    throw err;
  }
  try {
    for (const n of store.notices) logError("SessionEnd", n, env);
    const cwd = resolveCwd(env, input.cwd);
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const reason = typeof input.reason === "string" && input.reason ? input.reason : "other";
    const iso = nowIso(now);
    const parked = transaction(store.db, () => {
      const db = store.db;
      const rows = db
        .prepare("SELECT id, cwd, session_id FROM workloads WHERE status = 'open'")
        .all()
        .filter((w) => (sessionId && w.session_id === sessionId) || (!w.session_id && isWithin(cwd, w.cwd)));
      const why = `session ended (${reason})`;
      for (const w of rows) {
        db.prepare("UPDATE workloads SET status = 'parked', status_reason = ?, status_by = 'hook:SessionEnd', last_seen_at = ? WHERE id = ?").run(why, iso, w.id);
        db.prepare("INSERT INTO decisions (id, workload_id, kind, body, made_by, made_at) VALUES (?,?,?,?,?,?)").run(newId("de", now), w.id, "park", why, "hook:SessionEnd", iso);
      }
      if (sessionId) db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?").run(iso, reason, sessionId);
      return rows.map((w) => w.id);
    }, store.dbPath);
    return { parked };
  } finally {
    store.db.close();
  }
}

if (invokedDirectly(import.meta.url)) {
  // Output is discarded by Claude Code for this event; return nothing so stdout stays empty.
  runHook("SessionEnd", (input) => (handle(input), null), { quiet: true });
}
