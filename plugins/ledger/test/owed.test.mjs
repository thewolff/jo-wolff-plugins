import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../lib/store.mjs";
import { moveOwed } from "../lib/owed.mjs";
import { sandbox, apply, askQuestion, idOf, openDb, row, count } from "./helpers.mjs";

const S = "s-owed";
const run = (box, line, opts = {}) => apply(box, line, { sessionId: S, ...opts }).results[0];

function moveCount(box, id) {
  const db = openDb(box);
  const n = count(db, "cc_owed_moves", "owed_id = ?", id);
  db.close();
  return n;
}

/** An owed item moved into `state` with fixed pointer "p1" and reason "r1". */
function itemIn(box, state) {
  const id = idOf(apply(box, `owe "work for ${state} ${Math.random().toString(36).slice(2, 6)}"`, { sessionId: S }));
  const setup = { owed: [], started: [`start ${id} "p1"`], deferred: [`hold ${id} "r1"`], dropped: [`drop ${id} "r1"`], done: [`done ${id}`] }[state];
  for (const l of setup) assert.equal(run(box, l).status, "ok", l);
  return id;
}

test("owed transitions: every cell of the state table; refused cells name the current state", () => {
  const box = sandbox();
  const verbs = { start: '"p1"', hold: '"r1"', drop: '"r1"', done: "" };
  // [from][verb] → expected status; a different pointer/reason on a same-state move is checked below.
  const table = {
    owed: { start: "ok", hold: "ok", drop: "ok", done: "ok" },
    started: { start: "noop", hold: "ok", drop: "ok", done: "ok" },
    deferred: { start: "ok", hold: "noop", drop: "ok", done: "ok" },
    dropped: { start: "refused", hold: "refused", drop: "refused", done: "refused" },
    done: { start: "refused", hold: "refused", drop: "refused", done: "refused" },
  };
  const to = { start: "started", hold: "deferred", drop: "dropped", done: "done" };
  for (const [from, row_] of Object.entries(table)) {
    for (const [verb, want] of Object.entries(row_)) {
      const id = itemIn(box, from);
      const movesBefore = moveCount(box, id);
      const r = run(box, `${verb} ${id} ${verbs[verb]}`.trim());
      // The batch reports a noop as ok; a noop is told apart by its message and by writing no move.
      assert.equal(r.status, want === "noop" ? "ok" : want, `${from} + ${verb}: ${r.message}`);
      if (want === "noop") assert.match(r.message, /already/, `${from} + ${verb}`);
      assert.equal(moveCount(box, id) - movesBefore, want === "ok" ? 1 : 0, `${from} + ${verb} move rows`);
      const db = openDb(box);
      const state = row(db, "SELECT state FROM cc_owed WHERE id = ?", id).state;
      db.close();
      if (want === "ok") assert.equal(state, to[verb], `${from} + ${verb}`);
      else assert.equal(state, from, `${from} + ${verb} leaves the state`);
      if (want === "refused") assert.match(r.message, new RegExp(`is ${from}`), `${from} + ${verb} names the state`);
    }
  }
  const started = itemIn(box, "started");
  const other = run(box, `start ${started} "another agent"`);
  assert.equal(other.status, "refused");
  assert.match(other.message, /is already started \(p1\)/);
  const deferred = itemIn(box, "deferred");
  const otherWhy = run(box, `hold ${deferred} "another reason"`);
  assert.equal(otherWhy.status, "refused");
  assert.match(otherWhy.message, /is already deferred \(r1\)/);
});

test("owed moves: start, hold and drop need their text; a bare `hold ow-…` is refused naming the reason", () => {
  const box = sandbox();
  const id = itemIn(box, "owed");
  for (const verb of ["start", "hold", "drop"]) {
    const r = run(box, `${verb} ${id}`);
    assert.equal(r.status, "refused", verb);
    assert.match(r.message, verb === "start" ? /pointer/ : /reason/, verb);
  }
  const db = openDb(box);
  assert.equal(row(db, "SELECT state FROM cc_owed WHERE id = ?", id).state, "owed");
  db.close();
  const held = run(box, `hold ${id} "after the deploy window, Friday"`);
  assert.equal(held.status, "ok", held.message);
  const db2 = openDb(box);
  assert.deepEqual(row(db2, "SELECT state, reason FROM cc_owed WHERE id = ?", id), { state: "deferred", reason: "after the deploy window, Friday" });
  assert.equal(count(db2, "cc_owed_moves", "owed_id = ? AND kind = 'move'", id), 1);
  db2.close();
});

test("owed moves: a race between two connections gives one move and one refusal", () => {
  const box = sandbox();
  const id = itemIn(box, "owed");
  const a = openStore({ env: box.env, cwd: box.work }).db;
  const b = openStore({ env: box.env, cwd: box.work }).db;
  const iso = new Date().toISOString();
  const moveIn = (db, verb, text) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = moveOwed(db, id, verb, text, { by: "agent", iso, sessionId: S });
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const first = moveIn(a, "done", null);
  const second = moveIn(b, "drop", "too late");
  a.close();
  b.close();
  assert.equal(first.status, "ok", first.message);
  assert.equal(second.status, "refused");
  assert.match(second.message, /is done/);
  const db = openDb(box);
  assert.equal(count(db, "cc_owed_moves", "owed_id = ? AND kind = 'move'", id), 1);
  db.close();
});

test("answer: a plain answer creates one owed row and one create move, and the answer line keeps its text", () => {
  const box = sandbox();
  const q = askQuestion(box, { name: "ship", options: "yes,no" });
  const r = run(box, `answer ${q} yes`);
  assert.equal(r.status, "ok", r.message);
  assert.match(r.message, new RegExp(`^an-[a-z0-9]+ yes → ${q} \\(ship\\) · owed: ow-[a-z0-9]+ \\(ship: yes\\); start, hold or drop it before the turn ends$`));
  const db = openDb(box);
  const item = row(db, "SELECT * FROM cc_owed WHERE question_id = ?", q);
  assert.equal(item.origin, "answer");
  assert.equal(item.state, "owed");
  assert.equal(item.session_id, S);
  assert.equal(item.answer_id, r.id);
  assert.equal(count(db, "cc_owed_moves", "owed_id = ? AND kind = 'create'", item.id), 1);
  db.close();
});

test("answer: --nothing creates no row and one nothing move; --pointer creates a started row; --work sets the body", () => {
  const box = sandbox();
  const q1 = askQuestion(box, { name: "one", options: "yes,no" });
  const n = run(box, `answer ${q1} yes --nothing`);
  assert.match(n.message, / · set nothing in motion$/);
  const q2 = askQuestion(box, { name: "two", options: "yes,no" });
  const p = run(box, `answer ${q2} yes --pointer "agent a7f"`);
  assert.match(p.message, / · started: ow-[a-z0-9]+ \(agent a7f\)$/);
  const q3 = askQuestion(box, { name: "three", options: "yes,no" });
  run(box, `answer ${q3} yes --work "migrate the feeds table"`);
  const db = openDb(box);
  assert.equal(count(db, "cc_owed", "question_id = ?", q1), 0);
  assert.equal(count(db, "cc_owed_moves", "kind = 'nothing' AND answer_id = ?", n.id), 1);
  assert.deepEqual(row(db, "SELECT state, pointer FROM cc_owed WHERE question_id = ?", q2), { state: "started", pointer: "agent a7f" });
  assert.equal(row(db, "SELECT body FROM cc_owed WHERE question_id = ?", q3).body, "migrate the feeds table");
  assert.equal(row(db, "SELECT word FROM cc_answers WHERE question_id = ?", q1).word, "yes", "the reply is the word, not `yes --nothing`");
  db.close();
});

test("answer: the body defaults to the allows text, else `name: reply`, cut to 200 characters", () => {
  const box = sandbox();
  const q = askQuestion(box, { name: "plan", options: "go,cancel", extra: ["--kind", "plan", "--allows", "go: ship the fix to staging; cancel: leave it"] });
  run(box, `answer ${q} go`);
  const long = askQuestion(box, { name: "x".repeat(150), options: "y".repeat(80) + ",no" });
  run(box, `answer ${long} ${"y".repeat(80)}`);
  const db = openDb(box);
  assert.equal(row(db, "SELECT body FROM cc_owed WHERE question_id = ?", q).body, "ship the fix to staging");
  const body = row(db, "SELECT body FROM cc_owed WHERE question_id = ?", long).body;
  assert.equal(body.length, 200);
  assert.ok(body.endsWith("…"));
  db.close();
});

test("answer: deny to an approval and cancel to a plan create nothing unless --work names work", () => {
  const box = sandbox();
  const ap = askQuestion(box, { name: "gate", options: "approve,deny", extra: ["--kind", "approval"] });
  const d = run(box, `answer ${ap} deny`);
  assert.match(d.message, / · set nothing in motion$/);
  const pl = askQuestion(box, { name: "route", options: "go,cancel", extra: ["--kind", "plan", "--allows", "go: do it; cancel: stop"] });
  run(box, `answer ${pl} cancel`);
  const ap2 = askQuestion(box, { name: "gate2", options: "approve,deny", extra: ["--kind", "approval"] });
  run(box, `answer ${ap2} deny --work "revert the flag instead"`);
  const plain = askQuestion(box, { name: "plain", options: "deny,other" });
  run(box, `answer ${plain} deny`);
  const db = openDb(box);
  assert.equal(count(db, "cc_owed", "question_id = ?", ap), 0);
  assert.equal(count(db, "cc_owed_moves", "kind = 'nothing' AND answer_id = ?", d.id), 1);
  assert.equal(count(db, "cc_owed", "question_id = ?", pl), 0);
  assert.equal(row(db, "SELECT body FROM cc_owed WHERE question_id = ?", ap2).body, "revert the flag instead");
  assert.equal(count(db, "cc_owed", "question_id = ?", plain), 1, "deny on an ordinary question is an answer like any other");
  db.close();
});

test("answer: a withdrawal creates nothing; an option literally named withdraw creates an item", () => {
  const box = sandbox();
  const q = askQuestion(box, { name: "gone", options: "a,b" });
  assert.equal(run(box, `withdraw ${q}`).status, "ok");
  const w = askQuestion(box, { name: "w", options: "withdraw,keep" });
  run(box, `answer ${w} withdraw`);
  const db = openDb(box);
  assert.equal(count(db, "cc_owed", "question_id = ?", q), 0);
  assert.equal(count(db, "cc_owed_moves", "1=1"), 1, "only the create move for the option named withdraw");
  assert.equal(count(db, "cc_owed", "question_id = ?", w), 1);
  db.close();
});

test("answer: a bad flag records the answer and an owed item, and says which flag was ignored", () => {
  const box = sandbox();
  const q1 = askQuestion(box, { name: "b1", options: "yes,no" });
  const r1 = run(box, `answer ${q1} yes --pointer`);
  assert.equal(r1.status, "ok", r1.message);
  assert.match(r1.message, / · owed: ow-[a-z0-9]+ .* · flag ignored: --pointer needs a value$/);
  const q2 = askQuestion(box, { name: "b2", options: "yes,no" });
  const r2 = run(box, `answer ${q2} yes --nothing --pointer "agent a1"`);
  assert.match(r2.message, / · owed: ow-[a-z0-9]+ .* · flag ignored: --nothing and --pointer together$/);
  const db = openDb(box);
  for (const q of [q1, q2]) {
    assert.equal(count(db, "cc_answers", "question_id = ?", q), 1);
    assert.equal(row(db, "SELECT state FROM cc_owed WHERE question_id = ?", q).state, "owed");
  }
  db.close();
});

test("wait: refused for a question not open or held, or not this session's; `wait none` clears it", () => {
  const box = sandbox();
  const id = itemIn(box, "owed");
  const answered = askQuestion(box, { name: "done-q", options: "a,b" });
  run(box, `answer ${answered} a --nothing`);
  const r1 = run(box, `wait ${id} ${answered}`);
  assert.equal(r1.status, "refused");
  assert.match(r1.message, /is answered/);
  const theirs = askQuestion(box, { name: "theirs", options: "a,b", sessionId: "s-other" });
  const r2 = run(box, `wait ${id} ${theirs}`);
  assert.equal(r2.status, "refused");
  assert.match(r2.message, /not this session's question/);
  const mine = askQuestion(box, { name: "mine", options: "a,b", sessionId: S });
  assert.equal(run(box, `wait ${id} ${mine}`).status, "ok");
  const db = openDb(box);
  assert.equal(row(db, "SELECT waits_on FROM cc_owed WHERE id = ?", id).waits_on, mine);
  db.close();
  assert.equal(run(box, `wait ${id} none`).status, "ok");
  const started = itemIn(box, "started");
  const r3 = run(box, `wait ${started} ${mine}`);
  assert.equal(r3.status, "refused");
  assert.match(r3.message, /is started/);
});

test("owe: records agent work; empty or over 200 characters refused; --pointer starts it", () => {
  const box = sandbox();
  const r = run(box, 'owe "rotate the staging key"');
  assert.equal(r.status, "ok");
  assert.match(r.message, /owed: rotate the staging key; start, hold or drop it before the turn ends$/);
  assert.equal(run(box, 'owe ""').status, "refused");
  assert.equal(run(box, `owe "${"z".repeat(201)}"`).status, "refused");
  const s = run(box, 'owe "re-run the scan" --pointer "background job 4"');
  assert.match(s.message, /started: re-run the scan \(background job 4\)$/);
  const db = openDb(box);
  assert.deepEqual(row(db, "SELECT origin, state, session_id FROM cc_owed WHERE id = ?", r.id), { origin: "agent", state: "owed", session_id: S });
  db.close();
});

test("pending: owed, started and deferred items follow the open questions; dropped and done do not show", () => {
  const box = sandbox();
  askQuestion(box, { name: "still-open", options: "a,b" });
  const owed = itemIn(box, "owed");
  const started = itemIn(box, "started");
  const deferred = itemIn(box, "deferred");
  const dropped = itemIn(box, "dropped");
  const done = itemIn(box, "done");
  const out = run(box, "pending").message;
  const at = (s) => out.indexOf(s);
  assert.ok(at("still-open") >= 0, out);
  for (const id of [owed, started, deferred]) assert.ok(at(id) > at("still-open"), `${id} after the questions:\n${out}`);
  for (const id of [dropped, done]) assert.equal(at(id), -1, `${id} not listed`);
});
