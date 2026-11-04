// sweep.mjs — leftover questions (0.3.3). An open or held question whose session has ended is
// still a question nobody is going to answer from that session; `pending` keeps listing it, the
// Stop rules keep standing down on it, and the ledger fills with rows that mean nothing.
//
//   staleQuestions   doctor's `stale` check: open or held rows whose session ended more than
//                    STALE_MS ago (24 h). Named with the way out (answer, withdraw, or ask again
//                    from a live session to adopt).
//   autoWithdraw     at SessionStart: open or held rows asked more than `sweep.autoWithdrawDays`
//                    ago (default 7) whose session has ended or that have no session, and no
//                    deadline still ahead, are withdrawn with a note naming the sweep; at most
//                    SWEEP_BATCH rows per start, the rest next time. Off with autoWithdrawDays 0.
//
// Both read `cc_sessions.ended_at`, which SessionEnd stamps; a session that never ended (crash,
// kill) is reached by the age rule only. A CLI question (no session) is never stale for doctor
// (it is nobody's session's) but is swept by age like the rest.

import { freshId, parseQuestion } from "./commands.mjs";
import { nowIso } from "./time.mjs";

export const STALE_MS = 24 * 3_600_000;
export const SWEEP_BATCH = 20;
export const DEFAULT_AUTO_WITHDRAW_DAYS = 7;
const DAY_MS = 24 * 3_600_000;

/**
 * Open or held questions whose session ended more than STALE_MS before `now`, oldest end first,
 * each with `ended_at`. Questions with no session are not included.
 */
export function staleQuestions(db, { now = Date.now() } = {}) {
  const cutoff = nowIso(now - STALE_MS);
  return db
    .prepare(
      `SELECT q.id, q.name, q.cwd, q.state, q.asked_at, s.ended_at
         FROM cc_questions q JOIN cc_sessions s ON s.id = q.session_id
        WHERE q.state IN ('open', 'held') AND s.ended_at IS NOT NULL AND s.ended_at < ?
        ORDER BY s.ended_at ASC, q.id ASC`,
    )
    .all(cutoff);
}

/** The doctor line for `staleQuestions`: { status, detail, lines }. */
export function staleCheck(db, { now = Date.now() } = {}) {
  const rows = staleQuestions(db, { now });
  if (!rows.length) return { status: "ok", detail: "no open or held question whose session ended more than 24h ago" };
  return {
    status: "warn",
    detail: `${rows.length} open or held question(s) whose session ended more than 24h ago: ${rows.map((r) => r.id).join(", ")}; answer <id> <option>, withdraw <id>, or ask it again from a live session to adopt it`,
    lines: rows.map((r) => `${r.id}  ${r.state.padEnd(4)}  ${r.name} · asked ${r.asked_at} · session ended ${r.ended_at} · ${r.cwd}`),
  };
}

/**
 * Withdraw up to SWEEP_BATCH open or held questions asked more than `days` days before `now`
 * whose session has ended or that have no session, skipping any with a deadline still ahead.
 * Runs inside the caller's transaction. Returns the withdrawn ids. `days` 0 → nothing.
 */
export function autoWithdraw(db, { now = Date.now(), days = DEFAULT_AUTO_WITHDRAW_DAYS } = {}) {
  if (!days || days <= 0) return [];
  const cutoff = nowIso(now - days * DAY_MS);
  const iso = nowIso(now);
  const rows = db
    .prepare(
      `SELECT q.*, s.ended_at
         FROM cc_questions q LEFT JOIN cc_sessions s ON s.id = q.session_id
        WHERE q.state IN ('open', 'held') AND q.asked_at < ?
          AND (q.session_id IS NULL OR s.ended_at IS NOT NULL)
          AND (q.deadline IS NULL OR q.deadline < ?)
        ORDER BY q.asked_at ASC, q.id ASC
        LIMIT ?`,
    )
    .all(cutoff, iso, SWEEP_BATCH)
    .map((r) => ({ ...parseQuestion(r), ended_at: r.ended_at }));
  const answer = db.prepare("INSERT INTO cc_answers (id, question_id, word, answered_by, answered_at, via, session_id) VALUES (?,?,?,?,?,?,?)");
  const flip = db.prepare("UPDATE cc_questions SET state = 'withdrawn', resolved_at = ? WHERE id = ?");
  const note = db.prepare("INSERT INTO cc_notes (id, cwd, kind, body, question_id, made_by, made_at, session_id, ref) VALUES (?,?,?,?,?,?,?,?,?)");
  const out = [];
  for (const q of rows) {
    const why = q.session_id ? `its session ended ${q.ended_at}` : "it had no session";
    answer.run(freshId(db, "cc_answers", "an", now), q.id, "withdraw", "ledger-sweep", iso, "cli", null);
    flip.run(iso, q.id);
    note.run(freshId(db, "cc_notes", "nt", now), q.cwd, "withdraw", `${q.id} (${q.name}) withdrawn by the sweep: asked ${q.asked_at}, more than ${days} day(s) ago, and ${why}; ask it again if it still matters`, q.id, "ledger-sweep", iso, null, null);
    out.push(q.id);
  }
  return out;
}
