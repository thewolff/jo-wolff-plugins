// owed.mjs — owed work: approved work the agent has not started, the store half of the
// forgotten-work guard. One cc_owed row per piece of work, one cc_owed_moves row per event.
//
// States: `owed` (blocks the end of a turn) → `started` (a pointer: the agent, session or command
// doing it), `deferred` (a reason; the verb is `hold`), `dropped` (a reason) or `done` (an
// optional ref). `dropped` and `done` are final. Waiting on the human is a link to a ledger
// question (`waits_on`), not a state: the item leaves the blocking set while that question is open
// or held and comes back, with no command, once it is answered or withdrawn.
//
// Moves (`moveOwed`), each one UPDATE guarded by the expected from-state plus one move row, inside
// the caller's transaction:
//   owed     → started (start) · deferred (hold) · dropped (drop) · done (done)
//   started  → deferred · dropped · done; `start` again with the same pointer is a noop, another
//              pointer is refused
//   deferred → started · dropped · done; `hold` again with the same reason is a noop
//   dropped, done → refused, final
// A move made by a session takes the item over (session_id set to it).
//
// Ownership (`owns`), first match wins: a tagged item belongs to its tagged session. Work from an
// answered question is tagged at creation with the session that asked it, whoever recorded the
// answer, and a move or wait by another session re-tags it, so a move takes the item over. A row
// made before that stamping, still tagged with the answering session and never moved by it,
// belongs to the asker. An untagged item belongs to S when made at or after S started in or
// around S's folder, or when its question is S's by commands.mjs ownedBySession. `blockingSet` is S's owed items with no open wait. Items in scope
// that S does not own are `leftover`: listed, never blocking.
//
// Visible lines: every move row carries `shown_at`; the Stop hook lists the session's unshown rows
// in its pass systemMessage and stamps them (`unshownEvents`, `markShown`).

import { freshId, inScope, isWithin, ownedBySession, sessionStart } from "./commands.mjs";
import { relative } from "./time.mjs";

export const OWED_TEXT_MAX = 200;
export const OWED_STATES = Object.freeze(["owed", "started", "deferred", "dropped", "done"]);
const FINAL = new Set(["dropped", "done"]);

/** `text` folded to one line and cut to `max` characters with a marker. */
export function cut(text, max = OWED_TEXT_MAX) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function getOwed(db, id) {
  const r = db.prepare("SELECT * FROM cc_owed WHERE id = ?").get(id);
  return r ? { ...r } : null;
}

function addMove(db, { kind, owedId = null, answerId = null, from = null, to = null, detail = null, by, iso, sessionId = null }) {
  db.prepare("INSERT INTO cc_owed_moves (kind, owed_id, answer_id, from_state, to_state, detail, moved_by, at, session_id) VALUES (?,?,?,?,?,?,?,?,?)").run(kind, owedId, answerId, from, to, detail, by, iso, sessionId);
}

/**
 * Insert one owed item and its `create` move. Call inside a transaction. `pointer` makes it
 * `started` at once. `ownerId` tags the item (default `sessionId`, which tags the move row).
 * Returns the item.
 */
export function createOwed(db, { cwd, body, origin, questionId = null, answerId = null, pointer = null, sessionId = null, ownerId = sessionId, by, iso, now = Date.now() }) {
  const id = freshId(db, "cc_owed", "ow", now);
  const state = pointer ? "started" : "owed";
  db.prepare(
    "INSERT INTO cc_owed (id, cwd, body, state, origin, question_id, answer_id, pointer, session_id, made_by, made_at, changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, cwd, cut(body), state, origin, questionId, answerId, pointer ? cut(pointer) : null, ownerId, by, iso, iso);
  addMove(db, { kind: "create", owedId: id, to: state, detail: pointer ? cut(pointer) : null, by, iso, sessionId });
  return getOwed(db, id);
}

/** A `nothing` move: an answer that set nothing in motion. Call inside a transaction. */
export function recordNothing(db, { answerId, detail = null, by, iso, sessionId = null }) {
  addMove(db, { kind: "nothing", answerId, detail, by, iso, sessionId });
}

const VERB_TO = { start: "started", hold: "deferred", drop: "dropped", done: "done" };
const ALLOWED = {
  owed: new Set(["started", "deferred", "dropped", "done"]),
  started: new Set(["deferred", "dropped", "done"]),
  deferred: new Set(["started", "dropped", "done"]),
};

/**
 * Move an item with `verb` (start, hold, drop, done). `text` is the pointer (start), the reason
 * (hold, drop) or the ref (done, optional). Call inside a transaction.
 * @returns {{ status: 'ok'|'noop'|'refused', item?: object, message: string }}
 */
export function moveOwed(db, id, verb, text, { by, iso, sessionId = null }) {
  const to = VERB_TO[verb];
  const value = text == null ? "" : String(text).replace(/\s+/g, " ").trim();
  const need = { start: 'a pointer: start <ow-id> "<agent id, session or command>"', hold: 'a reason: hold <ow-id> "<why, and until when>"', drop: 'a reason: drop <ow-id> "<why>"' }[verb];
  if (need && !value) return { status: "refused", message: `${verb} needs ${need}` };
  if (value.length > OWED_TEXT_MAX && verb !== "done") return { status: "refused", message: `the ${verb === "start" ? "pointer" : "reason"} is at most ${OWED_TEXT_MAX} characters; this one is ${value.length}` };
  const item = getOwed(db, id);
  if (!item) return { status: "refused", message: `no such owed item ${id}` };
  if (FINAL.has(item.state)) return { status: "refused", message: `${id} is ${item.state}; that is final` };
  if (item.state === to) {
    const same = verb === "start" ? item.pointer === value : verb === "hold" ? item.reason === value : false;
    if (same) return { status: "noop", item, message: `${id} already ${to}` };
    return { status: "refused", message: `${id} is already ${to}${item.pointer && to === "started" ? ` (${item.pointer})` : item.reason ? ` (${item.reason})` : ""}; ${to === "started" ? "finish it with done, or hold or drop it" : "start, drop or finish it"}` };
  }
  if (!ALLOWED[item.state]?.has(to)) return { status: "refused", message: `${id} is ${item.state}; it cannot move to ${to}` };
  const resolved = FINAL.has(to) ? iso : null;
  const sets = {
    started: ["pointer = ?", value],
    deferred: ["reason = ?", value],
    dropped: ["reason = ?", value],
    done: ["ref = ?", value || null],
  }[to];
  const changes = db
    .prepare(`UPDATE cc_owed SET state = ?, ${sets[0]}, session_id = coalesce(?, session_id), changed_at = ?, resolved_at = ? WHERE id = ? AND state = ?`)
    .run(to, sets[1], sessionId, iso, resolved, id, item.state).changes;
  if (!changes) {
    const now = getOwed(db, id);
    return { status: "refused", message: `${id} is now ${now?.state ?? "gone"}; nothing moved` };
  }
  addMove(db, { kind: "move", owedId: id, from: item.state, to, detail: value || null, by, iso, sessionId });
  return { status: "ok", item: getOwed(db, id), message: `${id} ${to}: ${item.body}${value ? ` (${value})` : ""}` };
}

/**
 * `wait <ow-id> <q-id>` links an owed item to the question it waits on; `wait <ow-id> none`
 * removes the link. Only from `owed`; the question must be open or held and this session's
 * (commands.mjs ownedBySession; with no session id, in scope for `cwd`). Call inside a transaction.
 */
export function waitOwed(db, id, questionId, { by, iso, sessionId = null, cwd }) {
  const item = getOwed(db, id);
  if (!item) return { status: "refused", message: `no such owed item ${id}` };
  if (item.state !== "owed") return { status: "refused", message: `${id} is ${item.state}; only owed work can wait on a question` };
  if (questionId === "none") {
    if (!item.waits_on) return { status: "noop", item, message: `${id} waits on nothing` };
    db.prepare("UPDATE cc_owed SET waits_on = NULL, session_id = coalesce(?, session_id), changed_at = ? WHERE id = ? AND state = 'owed'").run(sessionId, iso, id);
    addMove(db, { kind: "wait", owedId: id, detail: "none", by, iso, sessionId });
    return { status: "ok", item: getOwed(db, id), message: `${id} waits on nothing now; it is owed again` };
  }
  const q = db.prepare("SELECT id, name, cwd, state, session_id, asked_at FROM cc_questions WHERE id = ?").get(questionId);
  if (!q) return { status: "refused", message: `no such question ${questionId}` };
  if (q.state !== "open" && q.state !== "held") return { status: "refused", message: `${questionId} is ${q.state}; owed work can wait only on an open or held question` };
  const mine = sessionId ? ownedBySession(q, { sessionId, cwd, since: sessionStart(db, sessionId) }) : inScope(cwd, q.cwd);
  if (!mine) return { status: "refused", message: `${questionId} is not this session's question; ask it through the ledger first` };
  if (item.waits_on === questionId) return { status: "noop", item, message: `${id} already waits on ${questionId}` };
  db.prepare("UPDATE cc_owed SET waits_on = ?, session_id = coalesce(?, session_id), changed_at = ? WHERE id = ? AND state = 'owed'").run(questionId, sessionId, iso, id);
  addMove(db, { kind: "wait", owedId: id, detail: questionId, by, iso, sessionId });
  return { status: "ok", item: getOwed(db, id), message: `${id} waits on your answer to ${questionId} (${q.name}); it leaves the owed list until that question is answered or withdrawn` };
}

/** The session row a predicate needs: { id, cwd, started_at }. */
export function sessionView(db, sessionId, cwd) {
  if (!sessionId) return null;
  const r = db.prepare("SELECT id, cwd, started_at FROM cc_sessions WHERE id = ?").get(sessionId);
  return { id: sessionId, cwd, started_at: r?.started_at ?? null };
}

/** Whether item `i` belongs to session `s` ({ id, cwd, started_at }). */
export function owns(db, s, i) {
  if (!s) return false;
  const q = i.question_id ? db.prepare("SELECT session_id, cwd, asked_at FROM cc_questions WHERE id = ?").get(i.question_id) : null;
  if (i.session_id != null && (q?.session_id == null || i.session_id === q.session_id || tookOver(db, i))) return i.session_id === s.id;
  if (q?.session_id != null) return q.session_id === s.id;
  if (s.started_at && i.made_at >= s.started_at && (isWithin(s.cwd, i.cwd) || isWithin(i.cwd, s.cwd))) return true;
  return Boolean(q && ownedBySession(q, { sessionId: s.id, cwd: s.cwd, since: s.started_at }));
}

// Rows made before answers were stamped with the asker carry the answering session's id; only a
// move or wait by that session (not the create row) makes the tag outrank the question's asker.
function tookOver(db, i) {
  if (!i.id) return false;
  return Boolean(db.prepare("SELECT 1 FROM cc_owed_moves WHERE owed_id = ? AND kind IN ('move','wait') AND session_id = ? LIMIT 1").get(i.id, i.session_id));
}

function waitOpen(db, i) {
  if (!i.waits_on) return false;
  const q = db.prepare("SELECT state FROM cc_questions WHERE id = ?").get(i.waits_on);
  return Boolean(q && (q.state === "open" || q.state === "held"));
}

/** Session `sessionId`'s owed items with no open wait, oldest first. No session → []. */
export function blockingSet(db, { sessionId, cwd }) {
  const s = sessionView(db, sessionId, cwd);
  if (!s) return [];
  return db
    .prepare("SELECT * FROM cc_owed WHERE state = 'owed' ORDER BY made_at ASC, id ASC")
    .all()
    .map((r) => ({ ...r }))
    .filter((i) => owns(db, s, i) && !waitOpen(db, i));
}

/** Session `sessionId`'s items in `states`, oldest first (`owed` includes waiting ones). */
export function sessionItems(db, { sessionId, cwd, states = ["owed", "started", "deferred"] }) {
  const s = sessionView(db, sessionId, cwd);
  if (!s) return [];
  const marks = states.map(() => "?").join(", ");
  return db
    .prepare(`SELECT * FROM cc_owed WHERE state IN (${marks}) ORDER BY made_at ASC, id ASC`)
    .all(...states)
    .map((r) => ({ ...r }))
    .filter((i) => owns(db, s, i));
}

/** Open, started and deferred items in scope for `cwd` that session `sessionId` does not own. */
export function leftover(db, { sessionId, cwd }) {
  const s = sessionView(db, sessionId, cwd);
  return db
    .prepare("SELECT * FROM cc_owed WHERE state IN ('owed','started','deferred') ORDER BY made_at ASC, id ASC")
    .all()
    .map((r) => ({ ...r }))
    .filter((i) => inScope(cwd, i.cwd) && !owns(db, s, i));
}

/** Every open, started and deferred item in scope for `cwd`, oldest first (the `pending` list). */
export function itemsInScope(db, cwd) {
  return db
    .prepare("SELECT * FROM cc_owed WHERE state IN ('owed','started','deferred') ORDER BY made_at ASC, id ASC")
    .all()
    .map((r) => ({ ...r }))
    .filter((i) => inScope(cwd, i.cwd));
}

/** `pending` lines for owed items: `owed|started|deferred <ow-id>  # <body>[ · <pointer or reason>][ · waits on <q-id>]`. */
export function owedPendingLines(items) {
  return items.map((i) => {
    const extra = i.state === "started" ? ` · ${i.pointer}` : i.state === "deferred" ? ` · ${i.reason}` : "";
    return `${i.state} ${i.id}  # ${i.body}${extra}${i.waits_on ? ` · waits on ${i.waits_on}` : ""}`;
  });
}

/** One line per owed item for the agent: `- <body> (<ow-id>, owed <relative>)`, at most `cap`, then a count. */
export function owedListLines(items, { now = Date.now(), cap = 10, max = 120, cli = "ledger" } = {}) {
  const lines = items.slice(0, cap).map((i) => `- ${cut(i.body, max)} (${i.id}, owed ${relative(i.made_at, now)})`);
  if (items.length > cap) lines.push(`… and ${items.length - cap} more; run \`${cli} pending\``);
  return lines;
}

/**
 * Session `sessionId`'s move rows not yet shown, oldest first, each with what a visible line
 * needs: { id, kind, to_state, detail, body, question_name, word }.
 */
export function unshownEvents(db, { sessionId, cwd }) {
  if (!sessionId) return [];
  const s = sessionView(db, sessionId, cwd);
  return db
    .prepare(
      `SELECT m.id, m.kind, m.to_state, m.detail, m.session_id, m.owed_id, o.body, o.session_id AS owed_session, o.cwd, o.made_at, o.question_id,
              coalesce(q2.name, q.name) AS question_name, a.word, wq.name AS wait_name
         FROM cc_owed_moves m
         LEFT JOIN cc_owed o ON o.id = m.owed_id
         LEFT JOIN cc_answers a ON a.id = m.answer_id
         LEFT JOIN cc_questions q ON q.id = a.question_id
         LEFT JOIN cc_questions q2 ON q2.id = o.question_id
         LEFT JOIN cc_questions wq ON wq.id = m.detail
        WHERE m.shown_at IS NULL
        ORDER BY m.at ASC, m.id ASC`,
    )
    .all()
    .map((r) => ({ ...r }))
    .filter((r) => r.session_id === sessionId || (r.session_id == null && r.body && owns(db, s, { id: r.owed_id, session_id: r.owed_session, cwd: r.cwd, made_at: r.made_at, question_id: r.question_id })));
}

/** The person-facing line for one move row (no ids). */
export function eventLine(e) {
  if (e.kind === "nothing") return `ledger: your answer set nothing in motion: ${e.question_name ?? "a question"} → ${e.word ?? "?"}`;
  if (e.kind === "wait") return e.detail === "none" ? `ledger: owed again, no longer waiting: ${e.body}` : `ledger: waits on your answer to "${e.wait_name ?? e.detail}": ${e.body}`;
  if (e.kind === "create") return e.to_state === "started" ? `ledger: started: ${e.body} (${e.detail})` : `ledger: owed: ${e.body}`;
  if (e.to_state === "started") return `ledger: started: ${e.body} (${e.detail})`;
  if (e.to_state === "deferred") return `ledger: deferred: ${e.body}: ${e.detail}`;
  if (e.to_state === "dropped") return `ledger: dropped: ${e.body}: ${e.detail}`;
  if (e.to_state === "done") return `ledger: done: ${e.body}${e.detail ? ` → ${e.detail}` : ""}`;
  return `ledger: ${e.to_state}: ${e.body}`;
}

/** Stamp `shown_at` on the given move ids. Call inside a transaction. */
export function markShown(db, ids, iso) {
  const stmt = db.prepare("UPDATE cc_owed_moves SET shown_at = ? WHERE id = ? AND shown_at IS NULL");
  for (const id of ids) stmt.run(iso, id);
}
