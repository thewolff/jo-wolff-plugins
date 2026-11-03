#!/usr/bin/env node
// stop.mjs — Stop: refuse (once per turn) a turn that asks the human a question with no open
// q- row.
//
// Input read: last_assistant_message, prompt_id, stop_hook_active, session_id, cwd (hooks
// reference § Stop input, § Common input fields).
//
// Once per turn: a block records prompt_id in sessions.last_block_prompt. A later Stop for the
// same prompt_id passes without checking, so the agent is asked at most once per turn and a
// reply that still fails cannot loop. stop_hook_active = true with no guard record of ours also
// passes (another hook's continuation), and so does any Stop with no prompt_id to key on while
// stop_hook_active is true.
//
// Output on block: {"decision":"block","reason":"…"}; on pass nothing. Fail open: switch off →
// nothing; store busy/unavailable → pass with one systemMessage; anything thrown → runHook's
// systemMessage. Never exit 2.

import { transaction } from "../lib/db.mjs";
import { runHook, noticeField, invokedDirectly } from "../lib/failopen.mjs";
import { openQuestions } from "../lib/commands.mjs";
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

    const session = sessionId ? db.prepare("SELECT last_block_prompt FROM cc_sessions WHERE id = ?").get(sessionId) : null;
    if (promptId && session?.last_block_prompt === promptId) return pass();
    if (input.stop_hook_active === true && (!promptId || !session?.last_block_prompt)) return pass();

    const verdict = checkStop(input.last_assistant_message, {
      openQuestionIds: openQuestions(db, cwd).map((q) => q.id),
      forcing: store.config.forcing,
      cli: invocation(),
    });
    if (!verdict) return pass();

    if (sessionId) {
      transaction(
        db,
        () => {
          db.prepare(
            "INSERT INTO cc_sessions (id, cwd, started_at, last_block_prompt, last_block_rule) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_block_prompt = excluded.last_block_prompt, last_block_rule = excluded.last_block_rule",
          ).run(sessionId, cwd, iso, promptId, verdict.rule);
        },
        store.dbPath,
      );
    }
    return { ...noticeField(store.notices), decision: "block", reason: verdict.reason };
  });
}

if (invokedDirectly(import.meta.url)) {
  runHook("Stop", (input) => handle(input));
}
