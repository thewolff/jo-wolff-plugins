import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, promptApplicable, takeAnswerFlags } from "../lib/parse.mjs";
import { sandbox, hook, apply, askQuestion, idOf, openDb, row, count } from "./helpers.mjs";

// A fixed store view: q-d offers done and drop, q-h does not; ow-1 exists.
const QUESTIONS = {
  "q-d": { id: "q-d", options: ["done", "drop", "keep"], state: "open" },
  "q-h": { id: "q-h", options: ["yes", "no"], state: "open" },
};
const lookup = {
  question: (id) => QUESTIONS[id] ?? null,
  offering: (word) => Object.values(QUESTIONS).filter((q) => q.options.includes(word)).map((q) => q.id),
  optionWords: () => [...new Set(Object.values(QUESTIONS).flatMap((q) => q.options))],
  exists: (id) => id in QUESTIONS || id === "ow-1",
};
const p = (line) => parseLine(line, lookup);

test("owed verbs on an ow- id parse with their text; the missing text is the command's refusal, not the parser's", () => {
  assert.deepEqual([p('start ow-1 "agent a7"').verb, p('start ow-1 "agent a7"').arg], ["start", "agent a7"]);
  assert.deepEqual([p('hold ow-1 "after Friday"').verb, p('hold ow-1 "after Friday"').arg], ["hold", "after Friday"]);
  assert.deepEqual([p('drop ow-1 "not needed"').verb, p('drop ow-1 "not needed"').arg], ["drop", "not needed"]);
  assert.equal(p("done ow-1").verb, "done");
  assert.equal(p("done ow-1 abc123").arg, "abc123");
  assert.equal(p("wait ow-1 q-h").verb, "wait");
  assert.equal(p("wait ow-1 none").kind, "command");
  assert.equal(p("wait ow-1").kind, "refused");
  assert.equal(p("wait ow-1 tomorrow").kind, "refused");
  assert.equal(p("start ow-zz").kind, "refused", "an unknown ow- id is refused");
});

test("owed verbs against a q- id: a word the question offers answers it; otherwise refused naming the ow- id", () => {
  assert.deepEqual([p("done q-d").verb, p("done q-d").word], ["answer", "done"]);
  assert.deepEqual([p("drop q-d").verb, p("drop q-d").word], ["answer", "drop"]);
  for (const line of ["done q-h", "drop q-h", "start q-h", "wait q-h"]) {
    const r = p(line);
    assert.equal(r.kind, "refused", line);
    assert.match(r.reason, /ow-/, line);
  }
});

test("a bare `done` still answers the one open question offering it; a bare `start` with no such question is refused", () => {
  const r = p("done");
  assert.equal(r.kind, "command");
  assert.deepEqual([r.verb, r.id, r.word], ["answer", "q-d", "done"]);
  assert.equal(p("start").kind, "refused");
});

test("`hold q-…` parses exactly as before; `hold ow-…` is the defer move", () => {
  const q = p("hold q-h");
  assert.equal(q.verb, "hold");
  assert.equal(q.id, "q-h");
  const o = p('hold ow-1 "after the window"');
  assert.equal(o.id, "ow-1");
  assert.equal(o.arg, "after the window");
});

test("prompt application: no owed verb and no ow- id applies from a prompt; owe is free text", () => {
  for (const line of ['drop ow-1 "x"', "done ow-1", 'start ow-1 "x"', "wait ow-1 none", 'hold ow-1 "x"', 'owe "the work"']) {
    const parsed = p(line);
    assert.equal(parsed.kind, "command", line);
    assert.equal(promptApplicable(parsed), false, line);
  }
  assert.equal(promptApplicable(p("hold q-h")), true, "hold on a question still applies from a prompt");
  assert.equal(promptApplicable(p("done q-d")), true, "an answer by option word still applies");
});

test("typo cases: `ok q-…` on a question without ok is prose, never a write; `what` alone is prose", () => {
  assert.equal(p("ok q-h").kind, "prose");
  assert.equal(p("what").kind, "prose");
  assert.equal(p("owe").kind, "refused", "owe with no work is refused, not prose");
});

test("takeAnswerFlags: the three known flags leave the reply; unknown --x stays in it", () => {
  assert.deepEqual(takeAnswerFlags(["yes", "--nothing"]), { tail: ["yes"], answerFlags: { nothing: true } });
  assert.deepEqual(takeAnswerFlags(["yes", "--pointer", "agent a1", "--work", "ship it"]), { tail: ["yes"], answerFlags: { pointer: "agent a1", work: "ship it" } });
  assert.deepEqual(takeAnswerFlags(["yes", "--loud"]).tail, ["yes", "--loud"]);
  assert.equal(takeAnswerFlags(["yes", "--pointer"]).answerFlags.pointer, true, "a bare --pointer is kept as a flag with no value; the answer then ignores it");
});

test("`drop ow-…` typed into a prompt moves nothing and is reported as not applied", () => {
  const box = sandbox();
  const id = idOf(apply(box, 'owe "clean the cache"', { sessionId: "s-p" }));
  const r = hook(box, "user-prompt", { session_id: "s-p", cwd: box.work, hook_event_name: "UserPromptSubmit", prompt: `drop ${id} "not needed"` });
  assert.equal(r.code, 0, r.err);
  const db = openDb(box);
  assert.equal(row(db, "SELECT state FROM cc_owed WHERE id = ?", id).state, "owed");
  assert.equal(count(db, "cc_owed_moves", "owed_id = ? AND kind = 'move'", id), 0);
  db.close();
});

test("a typed `approve q-…` in a prompt creates an owed item for the prompt's session", () => {
  const box = sandbox();
  const q = askQuestion(box, { name: "go", options: "approve,deny", extra: ["--kind", "approval"] });
  const r = hook(box, "user-prompt", { session_id: "s-p", cwd: box.work, hook_event_name: "UserPromptSubmit", prompt: `approve ${q}` });
  assert.equal(r.code, 0, r.err);
  const db = openDb(box);
  assert.deepEqual(row(db, "SELECT origin, state, session_id FROM cc_owed WHERE question_id = ?", q), { origin: "answer", state: "owed", session_id: "s-p" });
  db.close();
});
