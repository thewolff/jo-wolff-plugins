// todo-unfinished.test.mjs — node --test
//
// The not-applicable cases are the point: a parse miss must return "not applicable", never a
// guessed unfinished item — a false "unfinished" is a false accusation inside a block reason.
//
// Run: node --test plugins/communication-rules/triggers/

import { test } from "node:test";
import assert from "node:assert/strict";
import { lastIncompleteTodos, todoJudgeContext, reportQuestion } from "./todo-unfinished.mjs";

const todoWrite = (todos) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos } }],
    },
  });

const assistantText = (text) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

// ─── must not fire ───────────────────────────────────────────────────────────

test("no todo call anywhere is not applicable", () => {
  const r = lastIncompleteTodos(`${assistantText("hello")}\n${assistantText("world")}\n`);
  assert.equal(r.applicable, false);
  assert.deepEqual(r.incomplete, []);
});

test("all items completed is not applicable", () => {
  const jsonl = todoWrite([
    { content: "write the check", status: "completed" },
    { content: "run the tests", status: "done" },
  ]);
  const r = lastIncompleteTodos(jsonl);
  assert.equal(r.applicable, false);
  assert.equal(r.total, 2);
});

test("an emptied todo list is a real state, not a miss, and does not fire", () => {
  const r = lastIncompleteTodos(todoWrite([]));
  assert.equal(r.applicable, false);
  assert.equal(r.total, 0);
});

test("the LAST todo write wins over an earlier unfinished one", () => {
  const jsonl = [
    todoWrite([
      { content: "first task", status: "in_progress" },
      { content: "second task", status: "pending" },
    ]),
    assistantText("working"),
    todoWrite([{ content: "first task", status: "completed" }, { content: "second task", status: "completed" }]),
  ].join("\n");
  const r = lastIncompleteTodos(jsonl);
  assert.equal(r.applicable, false);
});

test("a malformed line in the middle does not stop the backwards scan", () => {
  const jsonl = ["{ this line is torn", todoWrite([{ content: "only task", status: "in_progress" }])].join("\n");
  const r = lastIncompleteTodos(jsonl);
  assert.equal(r.applicable, true);
  assert.equal(r.incomplete[0].content, "only task");
});

test("a todo call whose items cannot be read is a miss, not a guess", () => {
  const weird = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "TodoWrite", input: { nope: true } }] },
  });
  const r = lastIncompleteTodos(weird);
  assert.equal(r.applicable, false);
});

test("a bare `todo` tool name (the OMP shape) matches too", () => {
  const omp = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "todo", input: { todos: [{ content: "x", status: "pending" }] } }] },
  });
  const r = lastIncompleteTodos(omp);
  assert.equal(r.applicable, true);
});

// ─── must fire ───────────────────────────────────────────────────────────────

test("an in_progress item at the last write fires with its content", () => {
  const jsonl = [
    todoWrite([{ content: "write the check", status: "completed" }]),
    todoWrite([
      { content: "wire the hook", status: "completed" },
      { content: "update the docs", status: "in_progress" },
      { content: "run the suite", status: "pending" },
    ]),
  ].join("\n");
  const r = lastIncompleteTodos(jsonl);
  assert.equal(r.applicable, true);
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.incomplete.map((i) => i.content),
    ["update the docs", "run the suite"],
  );
});

test("status matching is case-insensitive and item keys vary defensively", () => {
  const r = lastIncompleteTodos(
    todoWrite([
      { subject: "subject-keyed item", status: "IN_PROGRESS" },
      { text: "text-keyed item", status: "Pending" },
      { title: "title-keyed done", status: "DONE" },
    ]),
  );
  assert.equal(r.applicable, true);
  assert.deepEqual(
    r.incomplete.map((i) => i.content),
    ["subject-keyed item", "text-keyed item"],
  );
});

// ─── contract ────────────────────────────────────────────────────────────────

test("the judge context marks each unfinished item with its status", () => {
  const todos = lastIncompleteTodos(todoWrite([{ content: "update the docs", status: "in_progress" }]));
  const ctx = todoJudgeContext("the final message", todos);
  assert.match(ctx, /UNFINISHED TODO ITEMS AT LAST WRITE \(1 of 1\)/);
  assert.match(ctx, /\[in_progress\] update the docs/);
  assert.match(ctx, /END OF UNFINISHED ITEMS/);
  assert.match(reportQuestion, /violation=false/);
});

test("it never throws", () => {
  for (const bad of [undefined, null, 7, "", "{", "not jsonl at all", { toString: () => "{}" }]) {
    const r = lastIncompleteTodos(bad);
    assert.equal(typeof r.applicable, "boolean");
  }
});
