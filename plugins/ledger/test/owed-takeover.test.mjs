import test from "node:test";
import assert from "node:assert/strict";
import { blockingSet, sessionItems } from "../lib/owed.mjs";
import { sandbox, apply, askQuestion, openDb, row } from "./helpers.mjs";

const A = "s-asker";
const B = "s-answerer";
const ids = (items) => items.map((i) => i.id);

function sets(box, sessionId, states) {
  const db = openDb(box);
  try {
    return { blocking: ids(blockingSet(db, { sessionId, cwd: box.work })), items: ids(sessionItems(db, { sessionId, cwd: box.work, states })) };
  } finally {
    db.close();
  }
}

/** Session A asks, session B records the answer; returns the owed item's id. */
function answeredByB(box, name) {
  const q = askQuestion(box, { name, options: "yes,no", sessionId: A });
  const r = apply(box, `answer ${q} yes`, { sessionId: B }).results[0];
  assert.equal(r.status, "ok", r.message);
  const db = openDb(box);
  const id = row(db, "SELECT id FROM cc_owed WHERE question_id = ?", q).id;
  db.close();
  return id;
}

test("takeover (a): B answers A's question; the item is tagged with A and blocks A, not B", () => {
  const box = sandbox();
  const id = answeredByB(box, "ship");
  const db = openDb(box);
  assert.equal(row(db, "SELECT session_id FROM cc_owed WHERE id = ?", id).session_id, A);
  assert.equal(row(db, "SELECT session_id FROM cc_owed_moves WHERE owed_id = ? AND kind = 'create'", id).session_id, B, "the create move stays with the session that recorded it");
  db.close();
  assert.deepEqual(sets(box, A).blocking, [id]);
  assert.deepEqual(sets(box, B).blocking, []);
});

test("takeover (b): B's wait on A's item moves it to B; once B's question closes it blocks B, not A", () => {
  const box = sandbox();
  const id = answeredByB(box, "migrate");
  const bq = askQuestion(box, { name: "b-asks", options: "a,b", sessionId: B });
  assert.equal(apply(box, `wait ${id} ${bq}`, { sessionId: B }).results[0].status, "ok");
  assert.deepEqual(sets(box, A).blocking, [], "waiting: blocks nobody");
  assert.deepEqual(sets(box, B).blocking, [], "waiting: blocks nobody");
  assert.deepEqual(sets(box, A, ["owed"]).items, []);
  assert.deepEqual(sets(box, B, ["owed"]).items, [id]);
  assert.equal(apply(box, `answer ${bq} a --nothing`, { sessionId: B }).results[0].status, "ok");
  assert.deepEqual(sets(box, B).blocking, [id]);
  assert.deepEqual(sets(box, A).blocking, []);
});

test("takeover (b): B's start and hold on A's items put them in B's started and deferred lists, not A's", () => {
  const box = sandbox();
  const started = answeredByB(box, "one");
  const deferred = answeredByB(box, "two");
  assert.equal(apply(box, `start ${started} "agent 7"`, { sessionId: B }).results[0].status, "ok");
  assert.equal(apply(box, `hold ${deferred} "after the release"`, { sessionId: B }).results[0].status, "ok");
  assert.deepEqual(sets(box, B, ["started"]).items, [started]);
  assert.deepEqual(sets(box, B, ["deferred"]).items, [deferred]);
  assert.deepEqual(sets(box, A, ["started", "deferred"]).items, []);
});

test("takeover: a row made before the asker stamp (tagged with the answering session, never moved) still belongs to the asker", () => {
  const box = sandbox();
  const id = answeredByB(box, "old-row");
  const db = openDb(box);
  db.prepare("UPDATE cc_owed SET session_id = ? WHERE id = ?").run(B, id);
  db.close();
  assert.deepEqual(sets(box, A).blocking, [id]);
  assert.deepEqual(sets(box, B).blocking, []);
  assert.equal(apply(box, `hold ${id} "later"`, { sessionId: B }).results[0].status, "ok");
  assert.deepEqual(sets(box, B, ["deferred"]).items, [id], "a move by that session takes it over");
  assert.deepEqual(sets(box, A, ["deferred"]).items, []);
});
