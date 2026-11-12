import test from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../lib/parse.mjs";
import { blockingSet, owedListLines, sessionItems } from "../lib/owed.mjs";
import { owedSection, OWED_CAPS } from "../lib/inject.mjs";
import { sandbox, apply, askQuestion, cli, idOf, openDb, row, count } from "./helpers.mjs";

const A = "s-asker";
const B = "s-other";

function answerRow(box, q) {
  const db = openDb(box);
  try {
    return row(db, "SELECT word, via FROM cc_answers WHERE question_id = ?", q);
  } finally {
    db.close();
  }
}

test("answer: a quoted flag-looking reply is the reply, not a flag", () => {
  const p = parseLine('answer q-abc "--nothing"');
  assert.equal(p.kind, "command");
  assert.equal(p.reply, "--nothing");
  assert.deepEqual(p.answerFlags, {});
  const box = sandbox();
  const q = askQuestion(box, { name: "lit", options: "yes,no", sessionId: A });
  const r = apply(box, `answer ${q} "--nothing"`, { sessionId: A }).results[0];
  assert.equal(r.status, "ok", r.message);
  assert.deepEqual(answerRow(box, q), { word: "--nothing", via: "freeform" });
});

test("answer: a quoted value after --work keeps its leading dashes", () => {
  const p = parseLine('answer q-abc yes --work "--pointer x"');
  assert.equal(p.reply, "yes");
  assert.deepEqual(p.answerFlags, { work: "--pointer x" });
});

test("answer: a bare -- ends the flags, so argv can record literal flag text", () => {
  const p = parseLine("answer q-abc -- --nothing", undefined, ["answer", "q-abc", "--", "--nothing"]);
  assert.equal(p.reply, "--nothing");
  assert.deepEqual(p.answerFlags, {});
  const box = sandbox();
  const q = askQuestion(box, { name: "argv", options: "yes,no", sessionId: A });
  const r = cli(box, ["answer", q, "--", "--nothing"], { env: { LEDGER_SESSION_ID: A } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(answerRow(box, q), { word: "--nothing", via: "freeform" });
});

/** A asks, B answers, A moves the item with `line`; returns the item id. */
function movedByA(box, name, verb, text) {
  const q = askQuestion(box, { name, options: "yes,no", sessionId: A });
  assert.equal(apply(box, `answer ${q} yes`, { sessionId: B }).results[0].status, "ok");
  const db = openDb(box);
  const id = row(db, "SELECT id FROM cc_owed WHERE question_id = ?", q).id;
  db.close();
  assert.equal(apply(box, `${verb} ${id} "${text}"`, { sessionId: A }).results[0].status, "ok");
  return id;
}

function listed(box, sessionId, states) {
  const db = openDb(box);
  try {
    return sessionItems(db, { sessionId, cwd: box.work, states }).map((i) => i.id);
  } finally {
    db.close();
  }
}

for (const [verb, state, text] of [
  ["start", "started", "agent 7"],
  ["hold", "deferred", "after the release"],
]) {
  test(`takeover: B's same-${verb === "start" ? "pointer start" : "reason hold"} on A's ${state} item moves it to B, one move row`, () => {
    const box = sandbox();
    const id = movedByA(box, `same-${verb}`, verb, text);
    assert.deepEqual(listed(box, A, [state]), [id]);
    const r = apply(box, `${verb} ${id} "${text}"`, { sessionId: B }).results[0];
    assert.equal(r.status, "ok", r.message);
    assert.deepEqual(listed(box, B, [state]), [id]);
    assert.deepEqual(listed(box, A, [state]), []);
    const db = openDb(box);
    assert.equal(row(db, "SELECT session_id FROM cc_owed WHERE id = ?", id).session_id, B);
    assert.equal(count(db, "cc_owed_moves", "owed_id = ? AND kind = 'move' AND session_id = ?", id, B), 1);
    db.close();
    assert.equal(apply(box, `${verb} ${id} "${text}"`, { sessionId: B }).results[0].message, `${id} already ${state}`, "the owner repeating it is a noop");
    assert.equal(apply(box, `${verb} ${id} "${text}"`, { sessionId: A }).results[0].status, "ok", "and A can take it back");
    const db2 = openDb(box);
    assert.equal(count(db2, "cc_owed_moves", "owed_id = ? AND kind = 'move' AND session_id = ?", id, B), 1, "B's repeat wrote no row");
    db2.close();
  });
}

test("pending: the session's owed work from another folder is listed, marked with its folder", () => {
  const box = sandbox();
  const id = idOf(apply(box, 'owe "work over there"', { sessionId: A, cwd: box.sibling }));
  const out = apply(box, "pending", { sessionId: A }).results[0].message;
  assert.ok(out.includes(`owed ${id}  # work over there · in ${box.sibling}`), out);
  const other = apply(box, "pending", { sessionId: B }).results[0].message;
  assert.ok(!other.includes(id), "another session's out-of-scope work stays out of its plain pending");
});

test("pending --all lists owed work under its folder, even with no questions", () => {
  const box = sandbox();
  const id = idOf(apply(box, 'owe "work over there"', { sessionId: A, cwd: box.sibling }));
  const out = cli(box, ["pending", "--all"]).out;
  assert.equal(out, `${box.sibling}\nowed ${id}  # work over there\n`);
});

test("capped SessionStart list: every item it leaves out is shown by the pending it points to", () => {
  const box = sandbox();
  const n = OWED_CAPS.owed + 3;
  const ids = Array.from({ length: n }, (_, k) => idOf(apply(box, `owe "far item ${k}"`, { sessionId: A, cwd: box.sibling })));
  const db = openDb(box);
  const text = owedSection(db, box.work, A);
  db.close();
  assert.match(text, /… and 3 more; run `[^`]*pending --all`/);
  const out = apply(box, "pending --all", { sessionId: A }).results[0].message;
  for (const id of ids) assert.ok(out.includes(id), `${id} missing from pending --all:\n${out}`);
});

test("wait repeated from another session: it takes the item over with one wait move", () => {
  const box = sandbox();
  const id = idOf(apply(box, 'owe "needs a call"', { sessionId: A }));
  const q = askQuestion(box, { name: "call", options: "yes,no", sessionId: A });
  assert.equal(apply(box, `wait ${id} ${q}`, { sessionId: A }).results[0].status, "ok");
  askQuestion(box, { name: "call", options: "yes,no", sessionId: B });
  const db = openDb(box);
  assert.equal(row(db, "SELECT session_id FROM cc_questions WHERE id = ?", q).session_id, B, "B adopted the question");
  db.close();
  const r = apply(box, `wait ${id} ${q}`, { sessionId: B }).results[0];
  assert.equal(r.status, "ok", r.message);
  const waits = (sid) => {
    const d = openDb(box);
    try {
      return count(d, "cc_owed_moves", "owed_id = ? AND kind = 'wait' AND session_id = ?", id, sid);
    } finally {
      d.close();
    }
  };
  const db2 = openDb(box);
  assert.equal(row(db2, "SELECT session_id FROM cc_owed WHERE id = ?", id).session_id, B);
  db2.close();
  assert.equal(waits(B), 1);
  assert.equal(apply(box, `wait ${id} ${q}`, { sessionId: B }).results[0].message, `${id} already waits on ${q}`, "the owner repeating it is a noop");
  assert.equal(waits(B), 1, "B's repeat wrote no row");
  assert.equal(waits(A), 1);
  assert.equal(apply(box, `answer ${q} no --nothing`, { sessionId: B }).results[0].status, "ok");
  const db3 = openDb(box);
  assert.deepEqual(blockingSet(db3, { sessionId: B, cwd: box.work }).map((i) => i.id), [id]);
  assert.deepEqual(blockingSet(db3, { sessionId: A, cwd: box.work }).map((i) => i.id), []);
  db3.close();
});

test("capped owed lists point at pending --all, which shows every left-out item without a session id", () => {
  const box = sandbox();
  const n = OWED_CAPS.owed + 3;
  const ids = Array.from({ length: n }, (_, k) => idOf(apply(box, `owe "far item ${k}"`, { sessionId: A, cwd: box.sibling })));
  const db = openDb(box);
  const section = owedSection(db, box.work, A);
  const prompt = owedListLines(blockingSet(db, { sessionId: A, cwd: box.work }), { cap: 10 }).join("\n");
  db.close();
  assert.match(section, /… and 3 more; run `[^`]*pending --all`/);
  assert.match(prompt, new RegExp(`… and ${n - 10} more; run \`[^\`]*pending --all\``));
  const out = cli(box, ["pending", "--all"]).out;
  for (const id of ids) assert.ok(out.includes(id), `${id} missing from pending --all:\n${out}`);
});
