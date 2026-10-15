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
import {
  OMP_TODO_VIEW_RESULT,
  OMP_USER_TODO_EDIT_FIRST,
  OMP_USER_TODO_EDIT_SECOND,
  OMP_USER_TODO_EDIT_LAST,
} from "./fixtures/omp-todo-edit-sequence.mjs";

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

test("an OMP todo result without a details.phases array is not a snapshot: the scan goes on, as OMP's does", () => {
  // OMP's canonicalTodoPhases returns undefined for these, so its state is the earlier snapshot's.
  for (const details of [undefined, {}, { op: "done" }, { op: "done", phases: "nope" }]) {
    const r = lastIncompleteTodos([realFragment, ompCall("done"), ompResult(details)].join("\n"));
    assert.equal(r.applicable, true, `details=${JSON.stringify(details)}`);
    assert.equal(r.total, 5, `details=${JSON.stringify(details)}`);
  }
  const nothingEarlier = lastIncompleteTodos([ompCall("done"), ompResult({ op: "done" })].join("\n"));
  assert.equal(nothingEarlier.applicable, false);
});

// ─── OMP canonical state: user_todo_edit snapshots, skipped error/view results, OMP's shape ──

const userTodoEdit = (phases) => JSON.stringify({ type: "custom", customType: "user_todo_edit", data: { phases } });

const ompErrorResult = (details, id = "call_x") =>
  JSON.stringify({
    type: "message",
    message: { role: "toolResult", toolCallId: id, toolName: "todo", content: [{ type: "text", text: "Error" }], details, isError: true },
  });

const allCompleted = [
  { name: "Build", tasks: [{ content: "write it", status: "completed" }] },
  { name: "Ship", tasks: [{ content: "open the PR", status: "completed" }] },
];
const stillOpen = [
  { name: "Build", tasks: [{ content: "write it", status: "completed" }] },
  { name: "Ship", tasks: [{ content: "open the PR", status: "in_progress" }] },
];

test("the real eval-bridge sequence: user_todo_edit snapshots completing every item after a view result are not applicable", () => {
  const jsonl = [
    OMP_TODO_VIEW_RESULT,
    OMP_USER_TODO_EDIT_FIRST,
    OMP_USER_TODO_EDIT_SECOND,
    OMP_USER_TODO_EDIT_LAST,
    ompText("## Result\n\nThe swap audit is written; every tracked item is done."),
  ].join("\n");
  const r = lastIncompleteTodos(jsonl);
  assert.equal(r.applicable, false);
  assert.equal(r.total, 5, "the last user_todo_edit decides, with all 5 items read");
  assert.deepEqual(r.incomplete, []);
});

test("the real view result alone is not a snapshot, and the first real user_todo_edit is one", () => {
  assert.equal(lastIncompleteTodos(OMP_TODO_VIEW_RESULT).applicable, false, "a view result never decides");
  const r = lastIncompleteTodos([OMP_TODO_VIEW_RESULT, OMP_USER_TODO_EDIT_FIRST, ompText("bye")].join("\n"));
  assert.equal(r.applicable, true);
  assert.deepEqual(
    r.incomplete.map((it) => [it.status, it.phase, it.content]),
    [
      ["in_progress", "Comparison", "Compare each item to bundled OMP features"],
      ["pending", "Comparison", "Classify swapability for every inventoried item"],
      ["pending", "Comparison", "Respect Playwright Memory lease and install constraints"],
      ["pending", "Deliverable", "Write swap audit and safest migration order"],
    ],
  );
});

test("a user_todo_edit with open items after an all-completed todo result is applicable", () => {
  const jsonl = [ompCall("done"), ompResult({ op: "done", phases: allCompleted }), userTodoEdit(stillOpen), ompText("done")].join("\n");
  const r = lastIncompleteTodos(jsonl);
  assert.equal(r.applicable, true);
  assert.deepEqual(r.incomplete, [{ content: "open the PR", status: "in_progress", phase: "Ship" }]);
});

test("an error todo result after a snapshot is skipped, its call does not end the scan, and the earlier snapshot decides", () => {
  const errAfterOpen = lastIncompleteTodos(
    [realFragment, ompCall("done", "call_err"), ompErrorResult({ op: "done", phases: allCompleted }, "call_err"), ompText("bye")].join("\n"),
  );
  assert.equal(errAfterOpen.applicable, true, "an error result claiming all completed does not clear the earlier open list");
  assert.equal(errAfterOpen.total, 5);
  const errAfterDone = lastIncompleteTodos(
    [userTodoEdit(allCompleted), ompCall("append", "call_err"), ompErrorResult({ op: "append", phases: stillOpen }, "call_err")].join("\n"),
  );
  assert.equal(errAfterDone.applicable, false, "an error result carrying open items does not fire");
});

test("a view todo result after a snapshot is skipped, its call does not end the scan, and the earlier snapshot decides", () => {
  const viewAfterOpen = lastIncompleteTodos(
    [realFragment, ompCall("view", "call_view"), ompResult({ op: "view", phases: allCompleted }, "call_view")].join("\n"),
  );
  assert.equal(viewAfterOpen.applicable, true);
  assert.equal(viewAfterOpen.total, 5);
  const viewAfterDone = lastIncompleteTodos(
    [userTodoEdit(allCompleted), ompCall("view", "call_view"), ompResult({ op: "view", phases: stillOpen }, "call_view")].join("\n"),
  );
  assert.equal(viewAfterDone.applicable, false);
});

test("a skipped result only covers its own call: a later todo call without a result still ends the scan", () => {
  const r = lastIncompleteTodos(
    [realFragment, ompCall("view", "call_view"), ompResult({ op: "view", phases: stillOpen }, "call_view"), ompCall("done", "call_torn")].join("\n"),
  );
  assert.equal(r.applicable, false);
});

test("only a toolResult named exactly `todo` is an OMP snapshot", () => {
  const named = (toolName) =>
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "y", toolName, details: { op: "init", phases: stillOpen }, isError: false } });
  for (const toolName of ["Todo", "TodoWrite", "todo_list"]) {
    const r = lastIncompleteTodos([userTodoEdit(allCompleted), named(toolName)].join("\n"));
    assert.equal(r.applicable, false, `toolName=${toolName}`);
  }
});

test("a user_todo_edit without a phases array is not a snapshot: the scan goes on, as OMP's does", () => {
  for (const data of [undefined, {}, { phases: "nope" }]) {
    const entry = JSON.stringify({ type: "custom", customType: "user_todo_edit", data });
    const r = lastIncompleteTodos([realFragment, entry].join("\n"));
    assert.equal(r.applicable, true, `data=${JSON.stringify(data)}`);
  }
});

test("a snapshot failing OMP's isTodoPhase shape is unreadable and not applicable, never an [unknown] item", () => {
  const malformed = {
    "missing status": [{ name: "Ship", tasks: [{ content: "open the PR" }] }],
    "unknown status": [{ name: "Ship", tasks: [{ content: "open the PR", status: "todo" }] }],
    "uppercase status": [{ name: "Ship", tasks: [{ content: "open the PR", status: "PENDING" }] }],
    "non-string content": [{ name: "Ship", tasks: [{ content: 42, status: "pending" }] }],
    "missing content": [{ name: "Ship", tasks: [{ subject: "open the PR", status: "pending" }] }],
    "task not a record": [{ name: "Ship", tasks: ["open the PR"] }],
    "phase without tasks": [{ name: "Build" }],
    "non-string phase name": [{ name: 7, tasks: [{ content: "open the PR", status: "pending" }] }],
    "one bad phase among good": [...stillOpen, { name: "Wrap-up", tasks: [{ content: "x", status: "later" }] }],
  };
  for (const [label, phases] of Object.entries(malformed)) {
    // Each source is placed after an earlier open list so a fall-through would fire.
    const viaResult = lastIncompleteTodos([realFragment, ompCall("done"), ompResult({ op: "done", phases })].join("\n"));
    assert.equal(viaResult.applicable, false, `todo result: ${label}`);
    const viaEdit = lastIncompleteTodos([realFragment, userTodoEdit(phases)].join("\n"));
    assert.equal(viaEdit.applicable, false, `user_todo_edit: ${label}`);
  }
});

test("the judge context shows a Claude item's status without a phase", () => {
  const r = lastIncompleteTodos(todoWrite([{ content: "update the docs", status: "in_progress" }]));
  assert.ok(todoJudgeContext("msg", r).split("\n").includes("- [in_progress] update the docs"));
});
