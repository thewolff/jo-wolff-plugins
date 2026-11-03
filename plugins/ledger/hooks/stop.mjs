#!/usr/bin/env node
// stop.mjs — Stop: stamp the governing workload as seen, then refuse (once per turn) a turn
// that asks the human a question with no open q- row, or that calls an open wl- finished.
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

import { loadConfig } from "../lib/config.mjs";
import { transaction } from "../lib/db.mjs";
import { runHook, noticeField, invokedDirectly } from "../lib/failopen.mjs";
import { gateState, openQuestions } from "../lib/commands.mjs";
import { checkStop } from "../lib/stop-rules.mjs";
import { invocation } from "../lib/inject.mjs";
import { withStore, resolveCwd } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";

export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const cfg = loadConfig({ env });
  if (!cfg.config.hooks.stop) return null;
  return withStore({ env, now, notices: cfg.notices }, "the ledger stop check did not run", (store) => {
    const db = store.db;
    const cwd = resolveCwd(env, input.cwd);
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    const promptId = typeof input.prompt_id === "string" && input.prompt_id ? input.prompt_id : null;
    const iso = nowIso(now);
    const pass = () => noticeField(store.notices);

    const state = gateState(db, cwd);
    if (state.open) {
      transaction(
        db,
        () => {
          if (sessionId) db.prepare("UPDATE workloads SET last_seen_at = ?, session_id = ? WHERE id = ?").run(iso, sessionId, state.open.id);
          else db.prepare("UPDATE workloads SET last_seen_at = ? WHERE id = ?").run(iso, state.open.id);
        },
        store.dbPath,
      );
    }

    const session = sessionId ? db.prepare("SELECT last_block_prompt FROM sessions WHERE id = ?").get(sessionId) : null;
    if (promptId && session?.last_block_prompt === promptId) return pass();
    if (input.stop_hook_active === true && (!promptId || !session?.last_block_prompt)) return pass();

    const verdict = checkStop(input.last_assistant_message, {
      openQuestionIds: openQuestions(db, cwd).map((q) => q.id),
      isOpenWorkload: (id) => Boolean(db.prepare("SELECT 1 FROM workloads WHERE id = ? AND status = 'open'").get(id)),
      forcing: store.config.forcing,
      cli: invocation(),
    });
    if (!verdict) return pass();

    if (sessionId) {
      transaction(
        db,
        () => {
          db.prepare(
            "INSERT INTO sessions (id, cwd, started_at, last_block_prompt, last_block_rule) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_block_prompt = excluded.last_block_prompt, last_block_rule = excluded.last_block_rule",
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
