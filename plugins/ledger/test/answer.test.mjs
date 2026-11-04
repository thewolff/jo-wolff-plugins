import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { open, MIGRATIONS } from "../lib/db.mjs";
import { sandbox, apply, askQuestion, cli, hook, openDb, count, row } from "./helpers.mjs";

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

test("free-form: `answer <q-id> <reply>` not in the options records the reply as given, via freeform; log shows it", () => {
  const b = sandbox();
  const q = askQuestion(b, { name: "colour", options: "red,blue" });
  const r = cli(b, ["answer", q, "Purple,", "with", "a", "stripe"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`an-[a-z0-9]+ Purple, with a stripe → ${q} \\(colour\\) · freeform: not one of red, blue`));
  const db = openDb(b);
  assert.deepEqual(row(db, "SELECT word, via FROM cc_answers WHERE question_id = ?", q), { word: "Purple, with a stripe", via: "freeform" });
  assert.equal(row(db, "SELECT state FROM cc_questions WHERE id = ?", q).state, "answered");
  db.close();
  assert.match(cli(b, ["log"]).out, new RegExp(`answered \\(freeform\\): Purple, with a stripe → ${q} \\(colour\\)`));
  assert.match(apply(b, [`answer ${q} "Purple, with a stripe"`]).results[0].message, /already answered Purple, with a stripe/, "the same reply again is already answered");
  assert.match(apply(b, [`answer ${q} green`]).results[0].message, /an answer is final/);
  const long = askQuestion(b, { name: "long", options: "yes,no" });
  const tooLong = apply(b, [{ tokens: ["answer", long, "x".repeat(201)], text: "answer long" }]).results[0];
  assert.equal(tooLong.status, "refused");
  assert.match(tooLong.message, /at most 200 characters; this one is 201/);
});

test("free-form: an exact option is still recorded via cli; the short forms and the prompt hook take options only", () => {
  const b = sandbox();
  const q = askQuestion(b, { name: "colour", options: "red,blue" });
  assert.equal(cli(b, ["answer", q, "Blue"]).code, 0);
  let db = openDb(b);
  assert.deepEqual(row(db, "SELECT word, via FROM cc_answers WHERE question_id = ?", q), { word: "blue", via: "cli" });
  db.close();
  const q2 = askQuestion(b, { name: "shade", options: "red,blue" });
  assert.equal(apply(b, [`purple ${q2}`]).results[0].status, "refused", "<word> <q-id> stays strict");
  assert.equal(apply(b, ["1 purple"]).results[0].status, "refused", "an ordinal stays strict");
  const viaPrompt = apply(b, [`answer ${q2} purple`], { via: "prompt-hook" }).results[0];
  assert.equal(viaPrompt.status, "refused");
  assert.match(viaPrompt.message, /purple is not an option of .*options: red, blue \(or withdraw\)/);
  const typed = hook(b, "user-prompt", { session_id: "s-ff", cwd: b.work, prompt: `answer ${q2} purple` });
  assert.match(typed.json.hookSpecificOutput.additionalContext, /1: refused purple is not an option/);
  db = openDb(b);
  assert.equal(count(db, "cc_answers", "question_id = ?", q2), 0);
  db.close();
});

test("migration 4: a store at version 3 keeps its answer rows and then accepts via freeform", () => {
  const box2 = sandbox();
  const dir = join(box2.root, "v3");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "ledger.db");
  const old = new DatabaseSync(p);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec("CREATE TABLE cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const m of MIGRATIONS.slice(0, 3)) m(old);
  old.exec("INSERT INTO cc_meta VALUES ('schema_version', '3')");
  old.exec(`INSERT INTO cc_questions (id, cwd, name, body, options, default_opt, state, asked_by, asked_at, resolved_at)
            VALUES ('q-a1', '/w', 'a', 'A?', '["yes","no"]', 'yes', 'answered', 'agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'),
                   ('q-b2', '/w', 'b', 'B?', '["yes","no"]', 'yes', 'answered', 'agent', '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z'),
                   ('q-c3', '/w', 'c', 'C?', '["yes","no"]', 'yes', 'answered', 'agent', '2026-01-01T00:04:00.000Z', '2026-01-01T00:05:00.000Z')`);
  old.exec(`INSERT INTO cc_answers VALUES ('an-1', 'q-a1', 'yes', 'jo', '2026-01-01T00:01:00.000Z', 'cli'),
                                          ('an-2', 'q-b2', 'no', 'jo', '2026-01-01T00:03:00.000Z', 'prompt-hook')`);
  assert.throws(() => old.exec("INSERT INTO cc_answers VALUES ('an-3', 'q-c3', 'maybe', 'jo', 'x', 'freeform')"), /CHECK/);
  old.close();
  const { db } = open(p);
  assert.deepEqual(db.prepare("SELECT id, question_id, word, via FROM cc_answers ORDER BY id").all().map((x) => ({ ...x })), [
    { id: "an-1", question_id: "q-a1", word: "yes", via: "cli" },
    { id: "an-2", question_id: "q-b2", word: "no", via: "prompt-hook" },
  ]);
  db.exec("INSERT INTO cc_answers VALUES ('an-3', 'q-c3', 'maybe', 'jo', 'x', 'freeform')");
  assert.throws(() => db.exec("INSERT INTO cc_answers VALUES ('an-4', 'q-nope', 'yes', 'jo', 'x', 'cli')"), /FOREIGN KEY/);
  db.exec(`INSERT INTO cc_questions (id, cwd, name, body, options, default_opt, asked_by, asked_at) VALUES ('q-d4', '/w', 'd', 'D?', '["yes","no"]', 'yes', 'agent', 'x')`);
  assert.throws(() => db.exec("INSERT INTO cc_answers VALUES ('an-5', 'q-d4', 'no', 'jo', 'x', 'other')"), /CHECK/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
