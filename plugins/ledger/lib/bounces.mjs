// bounces.mjs — the bounce ledger: one cc_bounces row per Stop block or PreToolUse deny, so a
// later judge can see which rules fire, which the agent satisfies, which it walks past.
//
// Lifecycle of a row: inserted open (outcome NULL) when a hook bounces; set `satisfied` (with
// satisfied_at) when the remedy the bounce asked for happens later in the same session; set
// `bypassed` at SessionEnd if it is still open then.
//
// Matching "the remedy happened", per rule (the hook calls satisfyBounces with the check):
//   stopAnswerRule     at a later Stop of the same session and prompt_id: an answer or withdraw
//                      for one of the session's questions was recorded after the bounce.
//   stopAskRule        at a later Stop of the same session and prompt_id: the session asked a
//                      question (any state) after the bounce.
//   stopDecisionRule   at a later Stop of the same session and prompt_id: the session recorded a
//                      `note` after the bounce.
//   denyAskWithoutRow  a later AskUserQuestion in the same session that the gate allows.
//   pushNeedsNote      a later push command (git push, gh pr create) in the same session that
//                      the gate allows (which means a note or outcome now exists).
//   reviewGate         a later gated command in the same session that the review gate allows
//                      (with or without a notice).
// The Stop rules are matched on the remedy, not by re-running the text check, so a reply that
// merely drops the question mark or the decision phrase stays open (and ends `bypassed`).
//
// Every write here is fail-open: an error is logged to errors.log and never changes the hook's
// decision.

import { transaction } from "./db.mjs";
import { logError } from "./failopen.mjs";
import { isWithin, ownedBySession, sessionNotes, sessionStart } from "./commands.mjs";
import { nowIso } from "./time.mjs";

export const STOP_RULES = Object.freeze(["stopAnswerRule", "stopAskRule", "stopDecisionRule"]);

/** Insert one open bounce row; never throws. */
export function recordBounce(store, { sessionId = null, rule, promptId = null, tool = null, now = Date.now(), env = process.env, hook }) {
  try {
    transaction(
      store.db,
      () => {
        store.db.prepare("INSERT INTO cc_bounces (session_id, rule, prompt_id, tool, at) VALUES (?,?,?,?,?)").run(sessionId, rule, promptId, tool, nowIso(now));
      },
      store.dbPath,
    );
  } catch (err) {
    logError(hook, `bounce not recorded (${rule}): ${err.message}`, env);
  }
}

/**
 * Mark the session's open rows of `rules` satisfied where `check(row)` is true. `promptId`, when
 * given, restricts to rows of that prompt. Reads first and writes only when a row qualifies, so
 * the common case takes no write lock. Never throws.
 */
export function satisfyBounces(store, { sessionId, rules, promptId = null, check = () => true, now = Date.now(), env = process.env, hook }) {
  if (!sessionId) return 0;
  try {
    const marks = rules.map(() => "?").join(", ");
    const rows = store.db
      .prepare(`SELECT id, rule, prompt_id, at FROM cc_bounces WHERE session_id = ? AND outcome IS NULL AND rule IN (${marks})${promptId ? " AND prompt_id = ?" : ""}`)
      .all(sessionId, ...rules, ...(promptId ? [promptId] : []))
      .filter((r) => check(r));
    if (!rows.length) return 0;
    const iso = nowIso(now);
    transaction(
      store.db,
      () => {
        const update = store.db.prepare("UPDATE cc_bounces SET outcome = 'satisfied', satisfied_at = ? WHERE id = ? AND outcome IS NULL");
        for (const r of rows) update.run(iso, r.id);
      },
      store.dbPath,
    );
    return rows.length;
  } catch (err) {
    logError(hook, `bounces not marked satisfied: ${err.message}`, env);
    return 0;
  }
}

/**
 * SessionEnd: every row still open for the session becomes `bypassed`. A bare statement: the
 * SessionEnd hook runs it inside the same transaction that stamps the session ended, so the two
 * land together or not at all.
 */
export function bypassOpenBounces(db, sessionId) {
  if (!sessionId) return 0;
  return Number(db.prepare("UPDATE cc_bounces SET outcome = 'bypassed' WHERE session_id = ? AND outcome IS NULL").run(sessionId).changes);
}

/** Whether the remedy for a Stop-rule bounce `row` has happened in session `sessionId` since the bounce. */
export function stopRemedyDone(db, row, { sessionId, cwd }) {
  if (row.rule === "stopAnswerRule") {
    // An answer or withdraw after the bounce, recorded by this session, or for a question that
    // belongs to it by the same rule the Stop check used (tagged, or untagged in or around cwd).
    const since = sessionStart(db, sessionId);
    return db
      .prepare("SELECT q.session_id, q.cwd, q.asked_at, a.session_id AS answered_by FROM cc_answers a JOIN cc_questions q ON q.id = a.question_id WHERE a.answered_at > ?")
      .all(row.at)
      .some((r) => r.answered_by === sessionId || ownedBySession(r, { sessionId, cwd, since }));
  }
  if (row.rule === "stopAskRule") {
    return db
      .prepare("SELECT cwd, session_id FROM cc_questions WHERE asked_at >= ? AND (session_id = ? OR session_id IS NULL)")
      .all(row.at, sessionId)
      .some((q) => q.session_id === sessionId || isWithin(cwd, q.cwd) || isWithin(q.cwd, cwd));
  }
  if (row.rule === "stopDecisionRule") return sessionNotes(db, { sessionId, cwd, after: row.at }).length > 0;
  return false;
}

/** `7d` / `12h` → milliseconds; null for anything else. */
export function parseSpan(spec) {
  const m = /^(\d+)([dh])$/.exec(String(spec ?? ""));
  if (!m) return null;
  return Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
}

export const BOUNCES_DEFAULT_SINCE = "7d";
export const BOUNCES_RECENT = 20;

/**
 * `bounces [--since <N>d|<N>h]`: per rule (alphabetical) fired / satisfied / bypassed / open,
 * then the last BOUNCES_RECENT rows newest first. Columns are fixed and space-padded.
 */
export function renderBounces(db, { since = BOUNCES_DEFAULT_SINCE, now = Date.now() } = {}) {
  const span = parseSpan(since) ?? parseSpan(BOUNCES_DEFAULT_SINCE);
  const from = nowIso(now - span);
  const rows = db.prepare("SELECT * FROM cc_bounces WHERE at >= ? ORDER BY at DESC, id DESC").all(from);
  if (!rows.length) return `no bounces since ${from} (${since})`;
  const per = new Map();
  for (const r of rows) {
    if (!per.has(r.rule)) per.set(r.rule, { fired: 0, satisfied: 0, bypassed: 0, open: 0 });
    const c = per.get(r.rule);
    c.fired++;
    c[r.outcome ?? "open"]++;
  }
  const ruleWidth = Math.max(4, ...[...per.keys()].map((k) => k.length));
  const num = (n, w) => String(n).padStart(w);
  const out = [`bounces since ${from} (${since})`, `${"rule".padEnd(ruleWidth)}  fired  satisfied  bypassed  open`];
  for (const rule of [...per.keys()].sort()) {
    const c = per.get(rule);
    out.push(`${rule.padEnd(ruleWidth)}  ${num(c.fired, 5)}  ${num(c.satisfied, 9)}  ${num(c.bypassed, 8)}  ${num(c.open, 4)}`);
  }
  out.push("", `last ${Math.min(BOUNCES_RECENT, rows.length)}:`);
  for (const r of rows.slice(0, BOUNCES_RECENT)) {
    out.push(`${r.at}  ${(r.session_id ?? "-").slice(0, 8).padEnd(8)}  ${r.rule.padEnd(ruleWidth)}  ${(r.tool ?? "-").padEnd(15)}  ${r.outcome ?? "open"}`);
  }
  return out.join("\n");
}
