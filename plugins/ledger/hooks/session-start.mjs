#!/usr/bin/env node
// session-start.mjs — SessionStart: record the session, inject the folder's open state.
//
// Input read: session_id, cwd, source (hooks reference § SessionStart input).
// Side effect (0.3.2): open or held questions asked more than sweep.autoWithdrawDays (7) ago
// whose session has ended are withdrawn with a note, at most 20 per start (lib/sweep.mjs).
// Output: hookSpecificOutput.additionalContext with, in order and only when non-empty: open
// questions (the `pending` block), the last N notes/questions/answers, the verb summary. On
// `source: compact` only the questions and a one-line summary. Last (0.3.2), the repository's
// `.ai/decision-log/` entries where the newdle plugin's hook is not on to inject them
// (lib/decision-log.mjs readDecisionLog; `decisionLog.enabled` false turns it off).
//
// Fail open: config switch off → exit 0 before the store is touched; store busy or unavailable →
// no injection and one systemMessage line; anything thrown → runHook's systemMessage.

import { StoreError, transaction } from "../lib/db.mjs";
import { runHook, noticeField, invokedDirectly, logError } from "../lib/failopen.mjs";
import { buildInjection, invocation } from "../lib/inject.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { appendFileSync } from "node:fs";

const SESSION_ID_OK = /^[A-Za-z0-9_.-]+$/;
import { nowIso } from "../lib/time.mjs";
import { autoWithdraw } from "../lib/sweep.mjs";
import { sessionStartLines, stampFirstSeen } from "../lib/digest.mjs";
import { readDecisionLog, repoRoot } from "../lib/decision-log.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "sessionStart");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg, hook: "SessionStart" }, "no injection this session", (store) => {
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const notices = [...store.notices];
    let swept = [];
    if (sessionId) {
      // Best effort: the injection is read-only and still worth having when a writer holds the lock.
      try {
        transaction(
          store.db,
          () => {
            store.db
              .prepare("INSERT INTO cc_sessions (id, cwd, started_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, ended_at = NULL, end_reason = NULL")
              .run(sessionId, cwd, nowIso(now));
            // 0.3.2: questions asked more than sweep.autoWithdrawDays ago whose session has
            // ended are withdrawn with a note (at most 20 per start). The start context's
            // notes section shows the sweep's note when it concerns this folder.
            swept = autoWithdraw(store.db, { now, days: cfg.config.sweep?.autoWithdrawDays });
            // The dead-man's switch needs a first date to count from when nothing was ever posted.
            stampFirstSeen(store.db, now);
          },
          store.dbPath,
        );
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        notices.push(`ledger: database ${err.kind === "readonly" ? "read-only" : "busy"} at ${err.path}; this session was not recorded`);
      }
      if (swept.length) notices.push(`ledger: withdrew ${swept.length} question(s) asked more than ${cfg.config.sweep?.autoWithdrawDays ?? 7} days ago whose session had ended: ${swept.join(", ")} (\`log\` shows the notes)`);
    }
    // Later Bash commands get LEDGER_SESSION_ID through CLAUDE_ENV_FILE (hooks reference
    // § Persist environment variables), so the CLI can tag its rows with this session.
    if (sessionId && SESSION_ID_OK.test(sessionId) && typeof env.CLAUDE_ENV_FILE === "string" && env.CLAUDE_ENV_FILE) {
      try {
        appendFileSync(env.CLAUDE_ENV_FILE, `export LEDGER_SESSION_ID=${sessionId}\n`);
      } catch (err) {
        notices.push(`ledger: could not write ${env.CLAUDE_ENV_FILE} (${err.message}); CLI rows in this session will not carry its id`);
      }
    }
    const { text } = buildInjection(store.db, cwd, store.config, { source: input.source, now, env });
    // The weekly digest's exception lines (overdue, or attempted and failed) are for the human.
    let digest = [];
    try {
      digest = sessionStartLines(store.db, { config: store.config, now, cli: invocation() });
    } catch {
      /* advisory */
    }
    notices.push(...digest);
    // 0.3.2: the repository's decision log, where the newdle plugin's own hook will not inject it.
    let log = "";
    try {
      log = readDecisionLog(repoRoot(cwd).root, store.config);
    } catch (err) {
      logError("SessionStart", `decision log not read: ${err.message}`, env);
    }
    return {
      ...noticeField(notices),
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: [text, log].filter(Boolean).join("\n\n") },
    };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("SessionStart", (input) => handle(input));
}
