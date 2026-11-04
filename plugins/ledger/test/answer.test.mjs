import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, apply, askQuestion, openDb, count, row } from "./helpers.mjs";

const box = sandbox();

test("§7 row 3 (#315 #316 #320): `raise q-…` on options extend,accept,stop → refused with the options, no an- row", () => {
  const q = askQuestion(box, { name: "retry", options: "extend,accept,stop" });
  const b = apply(box, [`raise ${q}`]);
  assert.equal(b.results[0].status, "refused");
  assert.match(b.results[0].message, /options: extend, accept, stop \(or withdraw\)/);
  const db = openDb(box);
  assert.equal(count(db, "cc_answers", "question_id = ?", q), 0);
  assert.equal(db.prepare("SELECT state FROM cc_questions WHERE id = ?").get(q).state, "open");
  db.close();
});

test("§7 row 2 (#319): a question offering `withdraw` records the answer withdraw; one without it is withdrawn", () => {
  const q1 = askQuestion(box, { name: "with", options: "approve,deny,withdraw" });
  const q2 = askQuestion(box, { name: "without", options: "approve,deny" });
  const b = apply(box, [`withdraw ${q1}`, `withdraw ${q2}`]);
  assert.equal(b.applied, 2, JSON.stringify(b.results));
  const db = openDb(box);
  assert.equal(db.prepare("SELECT state FROM cc_questions WHERE id = ?").get(q1).state, "answered");
  assert.equal(db.prepare("SELECT word FROM cc_answers WHERE question_id = ?").get(q1).word, "withdraw");
  assert.equal(db.prepare("SELECT state FROM cc_questions WHERE id = ?").get(q2).state, "withdrawn");
  assert.equal(db.prepare("SELECT word FROM cc_answers WHERE question_id = ?").get(q2).word, "withdraw");
  assert.equal(count(db, "cc_notes", "kind = 'withdraw' AND question_id = ?", q2), 1, "a withdrawal leaves a note");
  assert.equal(count(db, "cc_notes", "kind = 'withdraw' AND question_id = ?", q1), 0, "an answer `withdraw` is just an answer");
  db.close();
});


test("an answer is recorded once; the same word again is `already answered`; a different word is refused", () => {
  const q = askQuestion(box, { name: "once", options: "approve,deny" });
  const first = apply(box, [`approve ${q}`]);
  assert.equal(first.results[0].status, "ok");
  const an = first.results[0].id;
  assert.match(an, /^an-/);
  const again = apply(box, [`approve ${q}`]);
  assert.equal(again.results[0].status, "ok");
  assert.equal(again.results[0].id, an);
  assert.match(again.results[0].message, new RegExp(`already answered approve \\(${an}\\)`));
  const other = apply(box, [`deny ${q}`]);
  assert.equal(other.results[0].status, "refused");
  assert.match(other.results[0].message, /an answer is final/);
  const db = openDb(box);
  assert.equal(count(db, "cc_answers", "question_id = ?", q), 1);
  db.close();
});

test("ordinal answers index the pending list in asked order", () => {
  const b2 = sandbox();
  const qa = askQuestion(b2, { body: "First?", name: "first", options: "yes,no" });
  const qb = askQuestion(b2, { body: "Second?", name: "second", options: "yes,no" });
  const b = apply(b2, ["2 no"]);
  assert.equal(b.results[0].status, "ok", b.results[0].message);
  assert.match(b.results[0].message, new RegExp(`no → ${qb}`));
  const again = apply(b2, ["2 yes"]);
  assert.equal(again.results[0].status, "refused");
  assert.match(again.results[0].message, /no pending question numbered 2; pending has 1/);
  const first = apply(b2, ["1 yes"]);
  assert.match(first.results[0].message, new RegExp(`yes → ${qa}`));
});

test("a bare option word applies when exactly one open question offers it", () => {
  const b3 = sandbox();
  const q = askQuestion(b3, { name: "bare", options: "green,red" });
  const b = apply(b3, ["green"]);
  assert.equal(b.results[0].status, "ok", b.results[0].message);
  assert.match(b.results[0].message, new RegExp(`green → ${q}`));
});

test("the actor is the configured user for human verbs and `agent` for agent verbs; the prompt hook is always the human", () => {
  const b4 = sandbox();
  b4.writeConfig({ user: "jo" });
  const q = askQuestion(b4, { name: "who", options: "approve,deny" });
  apply(b4, [`approve ${q}`], { via: "prompt-hook" });
  const nt = apply(b4, [{ tokens: ["note", "chose sqlite"], text: 'note "chose sqlite"' }], { by: "someone" }).results[0];
  const db = openDb(b4);
  assert.equal(db.prepare("SELECT asked_by FROM cc_questions WHERE id = ?").get(q).asked_by, "agent");
  assert.deepEqual(row(db, "SELECT answered_by, via FROM cc_answers WHERE question_id = ?", q), { answered_by: "jo", via: "prompt-hook" });
  assert.deepEqual(row(db, "SELECT made_by, kind, body FROM cc_notes WHERE id = ?", nt.id), { made_by: "someone", kind: "note", body: "chose sqlite" });
  db.close();
});
