import test from "node:test";
import assert from "node:assert/strict";
import { sandbox, apply, askQuestion, cli, hook } from "./helpers.mjs";
import { invocation } from "../lib/inject.mjs";

const start = (box, extra = {}) => ({ session_id: "s-all", cwd: box.work, hook_event_name: "SessionStart", source: "startup", ...extra });
const injected = (box, extra, opts) => {
  const r = hook(box, "session-start", start(box, extra), opts);
  assert.equal(r.code, 0, r.err);
  return r.json.hookSpecificOutput.additionalContext;
};
const elsewhereLines = (text) => text.split("\n").filter((l) => l.includes("other folder"));
const header = (n, m) => `ledger: ${n} question${n === 1 ? "" : "s"} waiting on the human in ${m} other folder${m === 1 ? "" : "s"} (asked by another window, not this folder's work). If the human's prompt answers one, run \`${invocation()} answer <q-id> <option>\` and say it is recorded. Otherwise, in your first reply, tell the human in one plain line per question that another window is waiting on them: the question's body, its options and its default when it has one. Never show the q- id:`;

test("pending --all from either of two folders lists both questions under their folder headers; plain pending stays scoped", () => {
  const box = sandbox();
  const a = askQuestion(box, { name: "in work", cwd: box.work });
  const b = askQuestion(box, { name: "in sibling", cwd: box.sibling });
  apply(box, [`hold ${b}`], { cwd: box.sibling });
  const expected = [
    box.sibling,
    `held ${b}  # in sibling · Which way (in sibling)?`,
    "",
    box.work,
    `${a}  # in work · Which way (in work)? · options: a, b / withdraw`,
  ].join("\n");
  for (const cwd of [box.work, box.sibling]) {
    const r = cli(box, ["pending", "--all"], { cwd });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `${expected}\n`);
  }
  const scoped = cli(box, ["pending"], { cwd: box.work }).out;
  assert.ok(scoped.includes(a), scoped);
  assert.ok(!scoped.includes(b), scoped);
  const scopedSibling = cli(box, ["pending"], { cwd: box.sibling }).out;
  assert.ok(scopedSibling.includes(b) && !scopedSibling.includes(a), scopedSibling);
});

test("pending --all orders oldest first within a folder and says so when nothing is waiting", () => {
  const box = sandbox();
  assert.equal(cli(box, ["pending", "--all"]).out, "no open or held questions in the ledger\n");
  const first = askQuestion(box, { name: "first", now: Date.parse("2026-11-01T00:00:00Z") });
  const second = askQuestion(box, { name: "second", now: Date.parse("2026-11-02T00:00:00Z") });
  const out = cli(box, ["pending", "--all"]).out;
  assert.ok(out.indexOf(first) < out.indexOf(second), out);
  assert.equal(cli(box, ["pending", "--everything"]).code, 1);
});

test("SessionStart from folder A with one open question in unrelated folder B → one line, N=1, M=1, last; answered → no line", () => {
  const box = sandbox();
  const b = askQuestion(box, { name: "over there", cwd: box.sibling });
  const text = injected(box);
  assert.deepEqual(elsewhereLines(text), [header(1, 1)]);
  // The block carries the folder and the question's full pending line (body, options, default, id): a session can record the reply without a lookup.
  const tail = text.split("\n").slice(-3);
  assert.equal(tail[0], header(1, 1));
  assert.equal(tail[1], box.sibling);
  assert.equal(tail[2], `${b}  # over there · Which way (over there)? · options: a, b / withdraw`);
  apply(box, [`answer ${b} a`], { cwd: box.sibling });
  assert.deepEqual(elsewhereLines(injected(box)), []);
});

test("SessionStart counts open and held questions per folder, pluralised", () => {
  const box = sandbox();
  const other = `${box.root}/elsewhere`;
  askQuestion(box, { name: "one", cwd: box.sibling });
  const held = askQuestion(box, { name: "two", cwd: box.sibling });
  apply(box, [`hold ${held}`], { cwd: box.sibling });
  askQuestion(box, { name: "three", cwd: other });
  const text = injected(box);
  assert.deepEqual(elsewhereLines(text), [header(3, 2)]);
  // Folders in path order; open before held within a folder; each line is the `pending`/`held` line.
  assert.match(text, new RegExp(`^${other}\\nq-\\S+  # three · .*\\n${box.sibling}\\nq-\\S+  # one · .*\\nheld ${held}  # two · Which way \\(two\\)\\? · options: a, b / withdraw$`, "m"));
});

test("a question in a parent or a subfolder of the session folder is in scope, not elsewhere", () => {
  const box = sandbox();
  askQuestion(box, { name: "parent", cwd: box.root });
  askQuestion(box, { name: "child", cwd: `${box.work}/sub` });
  assert.deepEqual(elsewhereLines(injected(box)), []);
});

test("a session in a parent folder sees a subfolder's open and held questions at SessionStart and in pending, each naming its folder", () => {
  const box = sandbox();
  const child = `${box.work}/projects-trial`;
  const open = askQuestion(box, { name: "child open", cwd: child });
  const held = askQuestion(box, { name: "child held", cwd: child });
  apply(box, [`hold ${held}`], { cwd: child });
  askQuestion(box, { name: "unrelated", cwd: box.sibling });
  const text = injected(box);
  assert.match(text, new RegExp(`^1\\. ${open}  # child open · .* · in ${child}$`, "m"));
  assert.match(text, new RegExp(`^- child held: .* \\(${held}, in ${child}\\)$`, "m"));
  assert.deepEqual(elsewhereLines(text), [header(1, 1)]);
  const pending = cli(box, ["pending"]).out;
  assert.match(pending, new RegExp(`^1\\. ${open}  # child open .* · in ${child}$`, "m"));
  assert.match(pending, new RegExp(`^held ${held}  # child held · .* · in ${child}$`, "m"));
  assert.ok(!pending.includes("unrelated"), pending);
  // From the subfolder itself, its own questions carry no folder suffix.
  assert.ok(!cli(box, ["pending"], { env: { LEDGER_CWD: child } }).out.includes(" · in "));
});

test("inject.elsewhere false → no line; compact source still carries it", () => {
  const box = sandbox();
  askQuestion(box, { name: "over there", cwd: box.sibling });
  assert.equal(elsewhereLines(injected(box, { source: "compact" })).length, 1);
  box.writeConfig({ inject: { elsewhere: false } });
  assert.deepEqual(elsewhereLines(injected(box)), []);
  assert.deepEqual(elsewhereLines(injected(box, { source: "compact" })), []);
});
