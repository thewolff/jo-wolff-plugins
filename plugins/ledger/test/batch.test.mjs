import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, apply, askQuestion, openDb, count } from "./helpers.mjs";
import { formatBatch, exitCodeFor, runBatch } from "../lib/batch.mjs";
import { openStore, makeCtx } from "../lib/store.mjs";

const box = sandbox();

test("§7 row 1: three lines, line 2 bad → lines 1 and 3 applied, output names line 2 and its reason", () => {
  const q1 = askQuestion(box, { body: "One?", name: "one", options: "approve,deny" });
  const q3 = askQuestion(box, { body: "Three?", name: "three", options: "approve,deny" });
  const b = apply(box, [`approve ${q1}`, "raise q-nope", `deny ${q3}`]);
  assert.equal(b.applied, 2);
  assert.equal(b.refused, 1);
  assert.equal(b.prose, 0);
  assert.equal(b.results[1].line, 2);
  assert.equal(b.results[1].status, "refused");
  assert.match(b.results[1].message, /no such question q-nope/);
  const text = formatBatch(b);
  const lines = text.split("\n");
  assert.match(lines[0], new RegExp(`^1: ok an-[a-z0-9]+ approve → ${q1}`));
  assert.match(lines[1], /^2: refused no such question q-nope/);
  assert.match(lines[2], new RegExp(`^3: ok an-[a-z0-9]+ deny → ${q3}`));
  assert.equal(lines[3], "applied 2, refused 1, not commands 0");
  assert.equal(exitCodeFor(b), 1);
  const db = openDb(box);
  assert.equal(count(db, "cc_answers", "question_id IN (?, ?)", q1, q3), 2);
  db.close();
});

test("order is kept, so a later line can depend on an earlier one (an ask, then an ordinal answer to it)", () => {
  const b = apply(box, [{ tokens: ["ask", "Dependent?", "--name", "dep", "--options", "a,b"], text: "" }, "1 b"]);
  assert.equal(b.applied, 2, JSON.stringify(b.results));
  assert.match(b.results[1].message, new RegExp(`b → ${b.results[0].id}`));
});

test("prose, blank and comment lines are reported and skipped; exit code 1 for prose, 0 when all applied", () => {
  const b = apply(box, ["", "# a comment", "thanks, looks good", "pending"]);
  assert.equal(b.blank, 2);
  assert.equal(b.prose, 1);
  assert.equal(b.applied, 1);
  const lines = formatBatch(b).split("\n");
  assert.equal(lines[0], "1: skipped (blank)");
  assert.equal(lines[1], "2: skipped (blank)");
  assert.equal(lines[2], "3: not a command");
  assert.equal(lines[3], "4: ok");
  assert.equal(exitCodeFor(b), 1);
  assert.equal(exitCodeFor(apply(box, ["pending", "help"])), 0);
});

test("a near-miss line reports closest and writes nothing", () => {
  const q = askQuestion(box, { name: "near", options: "approve,deny" });
  const b = apply(box, [`aprove ${q}`]);
  assert.equal(b.results[0].status, "not a command");
  assert.equal(b.results[0].message, "not a command; closest: approve");
  const db = openDb(box);
  assert.equal(count(db, "cc_answers", "question_id = ?", q), 0);
  db.close();
});

test("onlyPromptApplicable: free-text verbs are reported as not applied from a prompt", () => {
  const store = openStore({ env: box.env, cwd: box.work });
  try {
    const ctx = makeCtx({ store, cwd: box.work, via: "prompt-hook" });
    const b = runBatch(['note "sneaky"', "pending"], { db: store.db, ctx, onlyPromptApplicable: true });
    assert.equal(b.results[0].status, "not a command");
    assert.match(b.results[0].message, /not applied from a prompt/);
    assert.equal(b.results[1].status, "ok");
    assert.equal(count(store.db, "cc_notes", "body = 'sneaky'"), 0);
  } finally {
    store.db.close();
  }
});
