#!/usr/bin/env node
// stop.mjs — Stop: refuse (once per turn) a turn that asks the human a question with no open
// q- row, or that states a decision without recording a note this turn.
//
// Input read: last_assistant_message, prompt_id, stop_hook_active, session_id, cwd (hooks
// reference § Stop input, § Common input fields).
//
// Once per turn: a block records prompt_id in cc_sessions.last_block_prompt. A later Stop for
// the same prompt_id passes without checking, so the agent is asked at most once per turn and a
// reply that still fails cannot loop. stop_hook_active = true with no guard record of ours also
// passes (another hook's continuation), and so does any Stop with no prompt_id to key on while
// stop_hook_active is true.
//
// "This turn" for the decision rule runs from the previous Stop of the session (its
// cc_sessions.last_stop_at, stamped on every Stop, pass or block; the session's start before
// the first) to now: a note made in that window counts.
//
// Output on block: {"decision":"block","reason":"…"}; on pass nothing. Fail open: switch off →
// nothing; store busy/unavailable/read-only (the stamp is a write) → pass with one
// systemMessage; anything thrown → runHook's systemMessage. Never exit 2.

import { transaction } from "../lib/db.mjs";
import { runHook, noticeField, invokedDirectly } from "../lib/failopen.mjs";
import { openQuestions, sessionNotes } from "../lib/commands.mjs";
import { checkStop } from "../lib/stop-rules.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, hookConfig } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const ready = hookConfig(env, input, "stop");
  if (!ready) return null;
  const { cfg, cwd } = ready;
  return withStore({ env, now, notices: cfg.notices, cwd, cfg }, "the ledger stop check did not run", (store) => {
    const db = store.db;
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : null;
    const iso = nowIso(now);
    const pass = () => noticeField(store.notices);

    const session = sessionId ? db.prepare("SELECT started_at, last_block_prompt, last_stop_at FROM cc_sessions WHERE id = ?").get(sessionId) : null;
    const stamp = (verdict) => {
      if (!sessionId) return;
      transaction(
        db,
        () => {
          db.prepare(
            "INSERT INTO cc_sessions (id, cwd, started_at, last_stop_at, last_block_prompt, last_block_rule) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_stop_at = excluded.last_stop_at, last_block_prompt = coalesce(excluded.last_block_prompt, last_block_prompt), last_block_rule = coalesce(excluded.last_block_rule, last_block_rule)",
          ).run(sessionId, cwd, iso, iso, verdict ? promptId : null, verdict?.rule ?? null);
        },
        store.dbPath,
      );
    };
    if (promptId && session?.last_block_prompt === promptId) {
      stamp(null);
      return pass();
    }
    if (input.stop_hook_active === true && (!promptId || !session?.last_block_prompt)) return pass();

    const verdict = checkStop(input.last_assistant_message, {
      openQuestionIds: openQuestions(db, cwd).map((q) => q.id),
      turnNotes: sessionNotes(db, { sessionId, cwd, after: session?.last_stop_at ?? session?.started_at ?? null }).length,
      forcing: store.config.forcing,
      cli: invocation(),
    });
    stamp(verdict);
    if (!verdict) return pass();
    return { ...noticeField(store.notices), decision: "block", reason: verdict.reason };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("Stop", (input) => handle(input));
}
