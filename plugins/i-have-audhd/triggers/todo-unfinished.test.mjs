// todo-unfinished.test.mjs — node --test
//
// The not-applicable cases are the point: a parse miss must return "not applicable", never a
// guessed unfinished item — a false "unfinished" is a false accusation inside a block reason.
//
// Run: node --test 'plugins/i-have-audhd/triggers/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { lastIncompleteTodos, todoJudgeContext } from "./todo-unfinished.mjs";
import { OMP_TODO_CALL, OMP_TODO_RESULT } from "./fixtures/omp-todo-fragment.mjs";

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

test("a Claude tool_use named bare `todo` matches too (a shape OMP never writes)", () => {
  const bareTodo = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "todo", input: { todos: [{ content: "x", status: "pending" }] } }] },
  });
  const r = lastIncompleteTodos(bareTodo);
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

// ─── the OMP shape: the call holds an op, the toolResult's details.phases holds the list ──

// Synthetic entries in the shape of the real fragment in fixtures/omp-todo-fragment.mjs.
const ompCall = (op, id = "call_x") =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id, name: "todo", arguments: { op } }] },
  });

const ompResult = (details, id = "call_x") =>
  JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "todo",
      content: [{ type: "text", text: "list" }],
      details,
      isError: false,
    },
  });

const ompText = (text) =>
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

const realFragment = [OMP_TODO_CALL, OMP_TODO_RESULT].join("\n");

test("a real OMP todo call + result fires with the unfinished items, their status and phase", () => {
  const r = lastIncompleteTodos(`${realFragment}\n${ompText("wrapping up")}\n`);
  assert.equal(r.applicable, true);
  assert.equal(r.total, 5);
  assert.deepEqual(r.incomplete, [
    { content: "Persist context-only unfinished work", status: "in_progress", phase: "Persistence" },
    { content: "Run and verify wrap-up artifact", status: "pending", phase: "Wrap-up" },
  ]);
});

test("other tools' calls and results after the OMP todo result do not hide it", () => {
  const jsonl = [
    realFragment,
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }] },
    }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [] } }),
    ompText("done"),
  ].join("\n");
  const r = lastIncompleteTodos(jsonl);
  assert.equal(r.applicable, true);
  assert.equal(r.incomplete.length, 2);
});

test("the LAST OMP todo result wins, in either direction", () => {
  const allDone = { op: "done", phases: [{ name: "Inspection", tasks: [{ content: "a", status: "completed" }] }] };
  const laterDone = lastIncompleteTodos([realFragment, ompCall("done"), ompResult(allDone)].join("\n"));
  assert.equal(laterDone.applicable, false, "a later all-completed result clears the earlier unfinished one");
  const laterOpen = lastIncompleteTodos([ompCall("init"), ompResult(allDone), realFragment].join("\n"));
  assert.equal(laterOpen.applicable, true, "a later unfinished result is not cleared by an earlier complete one");
  assert.equal(laterOpen.total, 5);
});

test("an OMP list with every task completed is not applicable", () => {
  const r = lastIncompleteTodos(
    [
      ompCall("done"),
      ompResult({
        op: "done",
        phases: [
          { name: "Build", tasks: [{ content: "write it", status: "completed" }] },
          { name: "Ship", tasks: [{ content: "open the PR", status: "completed" }] },
        ],
      }),
    ].join("\n"),
  );
  assert.equal(r.applicable, false);
  assert.equal(r.total, 2);
});

test("OMP abandoned and blocked tasks are unfinished and keep their exact status", () => {
  const r = lastIncompleteTodos(
    [
      ompCall("drop"),
      ompResult({
        op: "drop",
        phases: [
          { name: "Build", tasks: [{ content: "Write it", status: "completed" }, { content: "Wait on CI", status: "blocked" }] },
          { name: "Ship", tasks: [{ content: "Open PR", status: "abandoned" }] },
        ],
      }),
    ].join("\n"),
  );
  assert.equal(r.applicable, true);
  assert.deepEqual(
    r.incomplete.map((it) => [it.status, it.phase, it.content]),
    [
      ["blocked", "Build", "Wait on CI"],
      ["abandoned", "Ship", "Open PR"],
    ],
  );
  const ctx = todoJudgeContext("final message", r).split("\n");
  assert.ok(ctx.includes("- [blocked] (Build) Wait on CI"));
  assert.ok(ctx.includes("- [abandoned] (Ship) Open PR"));
});

test("an OMP todo call whose result is missing is a miss, not a guess from its arguments", () => {
  // The earlier real fragment would fire; the later call has no result (torn or aborted).
  const r = lastIncompleteTodos([realFragment, ompCall("append", "call_torn"), ompText("bye")].join("\n"));
  assert.equal(r.applicable, false);
});

test("an OMP todo result without readable details.phases is a miss, not a fall-through", () => {
  for (const details of [undefined, {}, { phases: "nope" }, { phases: [{ name: "Build" }] }]) {
    const r = lastIncompleteTodos([realFragment, ompCall("view"), ompResult(details)].join("\n"));
    assert.equal(r.applicable, false, `details=${JSON.stringify(details)}`);
  }
});

test("the judge context shows a Claude item's status without a phase", () => {
  const r = lastIncompleteTodos(todoWrite([{ content: "update the docs", status: "in_progress" }]));
  assert.ok(todoJudgeContext("msg", r).split("\n").includes("- [in_progress] update the docs"));
});
