// transcript.test.mjs - lib/transcript.mjs: the bounded tail read, the turn boundary, and the tool
// calls of a turn. The turn and handback tests run on transcripts captured from a real Claude Code
// run (test/fixtures/capture-transcripts.sh); the byte-level cases build their own files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_IGNORE_TOOLS,
  TAIL_BYTES,
  handbackMessage,
  isTurnStart,
  lastAssistantText,
  parseEntries,
  readSession,
  readTail,
  toolCallsOf,
  turnStartIndex,
  turnToolCalls,
} from "../lib/transcript.mjs";
import { PLUGIN_ROOT, sandbox } from "./helpers.mjs";

const FIXTURES = join(PLUGIN_ROOT, "test", "fixtures");
const MAIN = join(FIXTURES, "cc-main-turns.jsonl");
const SUB = join(FIXTURES, "cc-subagent-handback.jsonl");

const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content, extra = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...extra });
const use = (id, name, input = {}) => ({ type: "tool_use", id, name, input });
const result = (id, content, extra = {}) => ({ type: "tool_result", tool_use_id: id, content, ...extra });

function writeLines(box, name, entries, tail = "") {
  const path = join(box.root, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n" + tail);
  return path;
}

test("readTail: the last N bytes as lines; the partial first line is dropped when the read starts past 0; whole only from offset 0; null for a missing file", () => {
  const box = sandbox();
  const path = join(box.root, "t.txt");
  writeFileSync(path, "alpha\nbravo\ncharlie\n");
  assert.deepEqual(readTail(path), { lines: ["alpha", "bravo", "charlie", ""], whole: true });
  assert.deepEqual(readTail(path, 10), { lines: ["charlie", ""], whole: false });
  assert.equal(readTail(join(box.root, "missing.txt")), null);
  assert.equal(readTail(""), null);
  assert.equal(readTail(box.root), null, "a directory cannot be read");
  assert.equal(TAIL_BYTES, 16 * 1024 * 1024);
});

test("readTail on a 600 MiB sparse file reads only the window and returns the last entries (no ERR_STRING_TOO_LONG)", () => {
  const box = sandbox();
  const path = join(box.root, "huge.jsonl");
  const last = JSON.stringify(assistant([{ type: "text", text: "the end" }])) + "\n";
  const fd = openSync(path, "w");
  ftruncateSync(fd, 600 * 1024 * 1024);
  writeSync(fd, "\n" + last, 600 * 1024 * 1024);
  closeSync(fd);
  const started = Date.now();
  const s = readSession(path);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(s.whole, false);
  assert.equal(lastAssistantText(s.entries), "the end");
});

test("parseEntries: torn lines, non-objects and blank lines are skipped", () => {
  assert.deepEqual(parseEntries(['{"a":1}', "", "  ", "{torn", "[1,2]", "null", "7", '{"b":2}']), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseEntries(null), []);
});

test("isTurnStart: a human string prompt and a text-part prompt open a turn; tool_result-only, isMeta, and a whitespace string do not", () => {
  assert.equal(isTurnStart(user("do it")), true);
  assert.equal(isTurnStart(user([{ type: "text", text: "do it" }])), true);
  assert.equal(isTurnStart(user([result("t1", "ok")])), false);
  assert.equal(isTurnStart(user("skill body", { isMeta: true })), false);
  assert.equal(isTurnStart(user("   \n")), false);
  assert.equal(isTurnStart(assistant([{ type: "text", text: "hi" }])), false);
  assert.equal(isTurnStart(null), false);
});

test("turnStartIndex: the last turn-opening entry; -1 when the window holds none", () => {
  const entries = [user("one"), assistant([use("a", "Bash")]), user([result("a", "ok")]), user("two"), user([result("b", "ok")])];
  assert.equal(turnStartIndex(entries), 3);
  assert.equal(turnStartIndex(entries.slice(4)), -1);
  assert.equal(turnStartIndex([]), -1);
});

test("turnToolCalls: distinct tool_use ids after the turn start; a tool_use repeated across split assistant entries counts once; dispatch and bookkeeping tools are ignored by default", () => {
  const entries = [
    user("earlier"),
    assistant([use("old", "Bash")]),
    user("now"),
    assistant([use("a", "Bash", { command: "ls" })]),
    assistant([use("a", "Bash", { command: "ls" }), use("b", "Read")]),
    assistant([use("c", "Agent"), use("d", "SubagentHandback", { message: "r" }), use("e", "ToolSearch"), use("f", "Grep")]),
  ];
  const t = turnToolCalls({ entries, whole: true });
  assert.equal(t.count, 3);
  assert.deepEqual(t.calls.map((c) => c.id), ["a", "b", "f"]);
  assert.equal(t.boundaryFound, true);
  assert.equal(turnToolCalls({ entries, whole: true }, { ignore: [] }).count, 6);
  for (const name of ["Agent", "Task", "SendMessage", "TaskStop", "ToolSearch", "Skill", "TodoWrite", "SubagentHandback"]) assert.ok(DEFAULT_IGNORE_TOOLS.includes(name), name);
});

test("turnToolCalls: an isMeta entry mid-turn does not reset the count", () => {
  const entries = [user("go"), assistant([use("a", "Bash")]), user([result("a", "ok")]), assistant([use("s", "Skill")]), user([result("s", "loaded")]), user("skill body", { isMeta: true }), assistant([use("b", "Bash"), use("c", "Bash")])];
  assert.equal(turnToolCalls({ entries, whole: true }).count, 3);
});

test("turnToolCalls: no boundary in a partial window → boundaryFound false and a lower-bound count; in a whole file → the whole file is the turn", () => {
  const entries = [assistant([use("a", "Bash"), use("b", "Bash")]), user([result("a", "ok")])];
  assert.deepEqual(turnToolCalls({ entries, whole: false }).boundaryFound, false);
  assert.equal(turnToolCalls({ entries, whole: false }).count, 2);
  assert.equal(turnToolCalls({ entries, whole: true }).boundaryFound, true);
  assert.equal(turnToolCalls(null).count, 0);
});

test("readSession: sidechain entries dropped on request and kept otherwise; null for a missing file", () => {
  const box = sandbox();
  const path = writeLines(box, "s.jsonl", [user("main"), assistant([use("a", "Bash")], { isSidechain: true }), assistant([{ type: "text", text: "main reply" }], { isSidechain: false })], "{torn");
  assert.equal(readSession(path).entries.length, 2);
  assert.equal(readSession(path, { skipSidechain: false }).entries.length, 3);
  assert.equal(readSession(join(box.root, "nope.jsonl")), null);
});

test("toolCallsOf: Bash success text from toolUseResult stdout plus stderr; failure 'Exit code N' → isError and exitCode N; WebFetch text from toolUseResult.result with requested and final URL; a call with no result has result null", () => {
  const entries = [
    user("go"),
    assistant([use("ok", "Bash", { command: "npm test" }), use("bad", "Bash", { command: "npm run lint" }), use("web", "WebFetch", { url: "https://a.example/x" }), use("redir", "WebFetch", { url: "https://b.example/" }), use("int", "Bash", { command: "sleep 9" }), use("pending", "Bash", { command: "make" })]),
    user([result("ok", "trimmed")], { toolUseResult: { stdout: "3 pass", stderr: "warn: x", interrupted: false } }),
    user([result("bad", "Exit code 2\nlint failed", { is_error: true })], { toolUseResult: "Error: Exit code 2\nlint failed" }),
    user([result("web", "<persisted-output>")], { toolUseResult: { result: "page text", url: "https://a.example/x", code: 200 } }),
    user([result("redir", "REDIRECT DETECTED: The URL redirects to a different host.\n\nOriginal URL: https://b.example/\nRedirect URL: https://c.example/final\n")]),
    user([result("int", "Command interrupted")], { toolUseResult: { stdout: "", stderr: "", interrupted: true } }),
  ];
  const [ok, bad, web, redir, int, pending] = toolCallsOf(entries);
  assert.deepEqual({ text: ok.result.text, isError: ok.result.isError, exitCode: ok.result.exitCode, interrupted: ok.result.interrupted }, { text: "3 pass\nwarn: x", isError: false, exitCode: null, interrupted: false });
  assert.deepEqual({ isError: bad.result.isError, exitCode: bad.result.exitCode, text: bad.result.text }, { isError: true, exitCode: 2, text: "Exit code 2\nlint failed" });
  assert.deepEqual({ text: web.result.text, finalUrl: web.result.finalUrl }, { text: "page text", finalUrl: "https://a.example/x" });
  assert.equal(redir.result.finalUrl, "https://c.example/final");
  assert.equal(int.result.interrupted, true);
  assert.equal(pending.result, null);
  assert.deepEqual(toolCallsOf([user([result("orphan", "x")])]), []);
});

test("handbackMessage: the last SubagentHandback input.message after the turn start; '' when absent", () => {
  const entries = [user("brief"), assistant([use("h0", "SubagentHandback", { message: "old" })]), user("follow-up"), assistant([use("h1", "SubagentHandback", { message: "first" })]), assistant([use("h2", "SubagentHandback", { message: "the report" })]), user([result("h2", "delivered")])];
  assert.equal(handbackMessage({ entries }), "the report");
  assert.equal(handbackMessage({ entries: entries.slice(0, 3) }), "");
  assert.equal(handbackMessage(null), "");
});

test("lastAssistantText: later tool-only entries and torn lines are skipped; a string content counts", () => {
  const box = sandbox();
  const path = writeLines(box, "l.jsonl", [user("x"), assistant([{ type: "text", text: "a" }, { type: "text", text: "b" }]), assistant([use("t", "Bash")])], "{torn");
  assert.equal(lastAssistantText(readSession(path).entries), "a\nb");
  assert.equal(lastAssistantText([assistant("plain string")]), "plain string");
  assert.equal(lastAssistantText([]), "");
});

// ─── captured fixtures ──────────────────────────────────────────────────────────────────

test("captured main transcript (cc-main-turns.jsonl): the turn's tool calls are counted across the isMeta skill body, with dispatch and bookkeeping tools ignored", () => {
  const session = readSession(MAIN);
  const all = turnToolCalls(session, { ignore: [] });
  const counted = turnToolCalls(session);
  const names = all.calls.map((c) => c.name);
  assert.ok(names.filter((n) => n === "Bash").length >= 3, names.join(","));
  assert.ok(names.includes("Skill"), names.join(","));
  assert.ok(names.includes("Agent") || names.includes("Task"), names.join(","));
  assert.equal(counted.count, all.calls.filter((c) => !DEFAULT_IGNORE_TOOLS.includes(c.name)).length);
  assert.ok(counted.count >= 4, `counted ${counted.count}`);
  assert.equal(counted.boundaryFound, true);
  assert.ok(session.entries.some((e) => e.type === "user" && e.isMeta === true), "the fixture holds an isMeta entry mid-turn");
  const bash = all.calls.filter((c) => c.name === "Bash" && c.result);
  assert.ok(bash.every((c) => c.result.isError === false && typeof c.result.text === "string"));
  assert.match(bash.find((c) => /echo one/.test(c.input.command)).result.text, /^one/);
  // The capture prompt asks for a WebFetch call, but the captured session had no WebFetch tool;
  // WebFetch result parsing is covered by the toolCallsOf test above.
});

test("captured subagent transcript (cc-subagent-handback.jsonl): every entry is a sidechain entry, kept when asked; the handback message is the report", () => {
  assert.equal(readSession(SUB).entries.length, 0, "a Stop-style read drops every subagent entry");
  const session = readSession(SUB, { skipSidechain: false });
  assert.ok(session.entries.length > 0);
  assert.ok(session.entries.every((e) => e.isSidechain === true));
  const calls = turnToolCalls(session);
  assert.ok(calls.calls.some((c) => c.name === "Bash"), calls.calls.map((c) => c.name).join(","));
  assert.ok(!calls.calls.some((c) => c.name === "SubagentHandback"), "the handback is not counted");
  assert.ok(toolCallsOf(session.entries).some((c) => c.name === "SubagentHandback"));
  assert.match(handbackMessage(session), /from-subagent/);
});
