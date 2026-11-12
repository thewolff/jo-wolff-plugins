import test from "node:test";
import assert from "node:assert/strict";
import { owns } from "../lib/owed.mjs";

const START = "2026-11-12T10:00:00.000Z";
const BEFORE = "2026-11-12T09:00:00.000Z";
const AFTER = "2026-11-12T11:00:00.000Z";
const me = { id: "s-me", cwd: "/work/proj", started_at: START };
const other = { id: "s-other", cwd: "/work/proj", started_at: START };

/** A db whose only query is owns()'s question lookup; `questions` maps id → row. */
function dbWith(questions = {}) {
  return { prepare: () => ({ get: (id) => questions[id] }) };
}

test("owns: work answered by session B on a question session A asked belongs to A, not B", () => {
  const db = dbWith({ "q-a": { session_id: "s-me", cwd: "/work/proj", asked_at: AFTER } });
  const item = { session_id: "s-other", cwd: "/work/proj", made_at: AFTER, question_id: "q-a" };
  assert.equal(owns(db, me, item), true);
  assert.equal(owns(db, other, item), false);
});

test("owns: an item tagged with another session is not owned in the same folder when no question owner decides", () => {
  assert.equal(owns(dbWith(), me, { session_id: "s-other", cwd: "/work/proj", made_at: AFTER, question_id: null }), false);
  const untaggedQ = dbWith({ "q-1": { session_id: null, cwd: "/work/proj", asked_at: AFTER } });
  assert.equal(owns(untaggedQ, me, { session_id: "s-other", cwd: "/work/proj", made_at: AFTER, question_id: "q-1" }), false);
  assert.equal(owns(dbWith(), me, { session_id: "s-other", cwd: "/work/proj", made_at: AFTER, question_id: "q-gone" }), false, "a question row that no longer exists");
});

test("owns: an item tagged with this session is owned in any folder when no question owner decides", () => {
  assert.equal(owns(dbWith(), me, { session_id: "s-me", cwd: "/elsewhere", made_at: BEFORE, question_id: null }), true);
  const untaggedQ = dbWith({ "q-2": { session_id: null, cwd: "/elsewhere", asked_at: BEFORE } });
  assert.equal(owns(untaggedQ, me, { session_id: "s-me", cwd: "/elsewhere", made_at: BEFORE, question_id: "q-2" }), true);
});

test("owns: an untagged item falls back to folder and start time, then to the question's owner", () => {
  const db = dbWith({ "q-3": { session_id: "s-me", cwd: "/elsewhere", asked_at: BEFORE }, "q-4": { session_id: null, cwd: "/work/proj", asked_at: AFTER } });
  assert.equal(owns(db, me, { session_id: null, cwd: "/work/proj/sub", made_at: AFTER, question_id: null }), true);
  assert.equal(owns(db, me, { cwd: "/work", made_at: AFTER }), true, "a row with no session_id field at all");
  assert.equal(owns(db, me, { session_id: null, cwd: "/elsewhere", made_at: AFTER, question_id: "q-3" }), true);
  assert.equal(owns(db, me, { session_id: null, cwd: "/elsewhere", made_at: AFTER, question_id: "q-4" }), true, "untagged question in this session's folder after it started");
  assert.equal(owns(db, me, { session_id: null, cwd: "/work/proj", made_at: BEFORE, question_id: null }), false);
  assert.equal(owns(db, me, { session_id: null, cwd: "/elsewhere", made_at: AFTER, question_id: null }), false);
  assert.equal(owns(db, null, { session_id: null, cwd: "/work/proj", made_at: AFTER }), false, "no session: nothing is owned");
});

test("owns: an item tagged with another session than its question's asker belongs to that session once it moved or waited the item", () => {
  const q = { session_id: "s-other", cwd: "/work/proj", asked_at: AFTER };
  const moved = new Set(["ow-taken"]);
  const db = { prepare: (sql) => ({ get: (a, b) => (sql.includes("cc_owed_moves") ? (moved.has(a) && b === "s-me" ? { 1: 1 } : undefined) : a === "q-o" ? q : undefined) }) };
  const taken = { id: "ow-taken", session_id: "s-me", cwd: "/work/proj", made_at: AFTER, question_id: "q-o" };
  assert.equal(owns(db, me, taken), true);
  assert.equal(owns(db, other, taken), false);
  const unmoved = { ...taken, id: "ow-unmoved" };
  assert.equal(owns(db, me, unmoved), false, "no move by the tagged session: the asker keeps it");
  assert.equal(owns(db, other, unmoved), true);
});
