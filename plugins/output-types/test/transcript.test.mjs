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
import { callStatus, receiptCalls, renderRecord } from "../lib/receipts.mjs";
import { PLUGIN_ROOT, sandbox } from "./helpers.mjs";

const FIXTURES = join(PLUGIN_ROOT, "test", "fixtures");
const MAIN = join(FIXTURES, "cc-main-turns.jsonl");
const SUB = join(FIXTURES, "cc-subagent-handback.jsonl");
const WEBFETCH = join(FIXTURES, "cc-webfetch.jsonl");
const BASH_EXIT = join(FIXTURES, "cc-bash-exit.jsonl");

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

test("toolCallsOf: a successful command whose own output says cancelled or interrupted is not marked interrupted", () => {
  const entries = [
    user("go"),
    assistant([use("c", "Bash", { command: "npm test" }), use("p", "Bash", { command: "./jobs" }), use("c2", "Bash", { command: "npm test" }), use("p2", "Bash", { command: "./jobs" })]),
    user([result("c", "0 tests cancelled\n12 pass")], { toolUseResult: { stdout: "0 tests cancelled\n12 pass", stderr: "", interrupted: false } }),
    user([result("p", "interrupted 0 of 4 workers; all jobs finished")], { toolUseResult: { stdout: "interrupted 0 of 4 workers; all jobs finished", stderr: "", interrupted: false } }),
    user([result("c2", "0 tests cancelled\n12 pass")]),
    user([result("p2", "interrupted 0 of 4 workers; all jobs finished")]),
  ];
  for (const call of toolCallsOf(entries)) assert.equal(call.result.interrupted, false, call.id);
});

test("toolCallsOf: a real interruption or rejection is still marked interrupted, by the structured flag or the harness marker", () => {
  const entries = [
    user("go"),
    assistant([use("i", "Bash", { command: "sleep 100" }), use("r", "Bash", { command: "rm -rf build" })]),
    user([result("i", "[Request interrupted by user for tool use]", { is_error: true })], { toolUseResult: { stdout: "", stderr: "", interrupted: true } }),
    user([result("r", "The user doesn't want to proceed with this tool use. The tool use was rejected.", { is_error: true })], { toolUseResult: "Error: The user doesn't want to proceed with this tool use. The tool use was rejected." }),
  ];
  const [i, r] = toolCallsOf(entries);
  assert.equal(i.result.interrupted, true);
  assert.equal(r.result.interrupted, true);
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
  // The capture prompt asks for a WebFetch call, but this session had no WebFetch tool; WebFetch
  // parsing is backed by the separate capture in cc-webfetch.jsonl (the test below).
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

test("captured WebFetch results (cc-webfetch.jsonl, Claude Code 2.1.318): success, cross-host redirect, HTTP 404 and an unresolvable host parse to the right text, status and URLs, and receipt matching uses them", () => {
  const calls = toolCallsOf(readSession(WEBFETCH).entries).filter((c) => c.name === "WebFetch");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.result), "every fetch has a captured result");
  const by = (frag) => calls.find((c) => c.input.url.includes(frag));
  const ok = by("example.com");
  const redirect = by("redirect-to");
  const missing = by("status/404");
  const dead = by("nonexistent.invalid");

  assert.deepEqual(
    { text: ok.result.text, isError: ok.result.isError, httpStatus: ok.result.httpStatus, finalUrl: ok.result.finalUrl, status: callStatus(ok) },
    { text: 'The page title is "Example Domain."', isError: false, httpStatus: 200, finalUrl: "https://example.com", status: "success" },
  );
  // The redirect target sits on a "Redirect URL (from the server's Location header …):" line.
  assert.match(redirect.result.text, /^REDIRECT DETECTED/);
  assert.equal(redirect.result.httpStatus, 302);
  assert.equal(redirect.result.finalUrl, "https://example.org/");
  // A 404 is not an is_error result; the HTTP status makes it an error in the record.
  assert.equal(missing.result.isError, false);
  assert.equal(missing.result.httpStatus, 404);
  assert.equal(callStatus(missing), "error");
  assert.match(missing.result.text, /HTTP 404 Not Found/);
  // An unreachable host is an is_error result whose toolUseResult is a plain string.
  assert.deepEqual(
    { isError: dead.result.isError, httpStatus: dead.result.httpStatus, finalUrl: dead.result.finalUrl, status: callStatus(dead) },
    { isError: true, httpStatus: null, finalUrl: null, status: "error" },
  );
  assert.match(dead.result.text, /ENOTFOUND nonexistent\.invalid/);

  // Matching: host case and a fragment are ignored; a redirect's target and its requested URL both match.
  const matchedUrl = (text) => receiptCalls({ text }, calls).matched.map((c) => c.input.url);
  assert.deepEqual(matchedUrl("per https://EXAMPLE.com#top the title is Example Domain"), ["https://example.com"]);
  assert.deepEqual(matchedUrl("per https://example.org/ the title is x"), [redirect.input.url]);
  assert.deepEqual(matchedUrl(`per ${redirect.input.url} it redirects`), [redirect.input.url]);
  assert.deepEqual(matchedUrl("per https://example.net/ nothing"), []);

  // The record names requested and final URLs and the status the fixture supports.
  const record = renderRecord([redirect, missing]);
  assert.ok(record.includes(`requested: ${redirect.input.url}\nfinal: https://example.org/\nstatus: success\nREDIRECT DETECTED`), record);
  assert.ok(record.includes("requested: https://httpbin.org/status/404\nfinal: https://httpbin.org/status/404\nstatus: error\nThe server returned HTTP 404"), record);
});

test("captured Bash exit codes (cc-bash-exit.jsonl, Claude Code 2.1.318): an Exit code line in successful output is output, not a code; an error result's code is the envelope's first line, not a later look-alike", () => {
  const calls = toolCallsOf(readSession(BASH_EXIT).entries).filter((c) => c.name === "Bash");
  assert.equal(calls.length, 3);
  const by = (frag) => calls.find((c) => c.input.command.includes(frag));
  const printed = by("printf 'Exit code 2");
  const exit3 = by("exit 3");
  const exit4 = by("exit 4");
  // The successful call's content itself opens with "Exit code 2" (it is the command's output); is_error is false.
  assert.equal(printed.result.isError, false);
  assert.match(printed.result.text, /^Exit code 2\nall fine/);
  assert.equal(printed.result.exitCode, null);
  assert.deepEqual({ isError: exit3.result.isError, exitCode: exit3.result.exitCode }, { isError: true, exitCode: 3 });
  assert.equal(exit4.result.isError, true);
  assert.equal(exit4.result.exitCode, 4, "the envelope's code, not the 'Exit code 9' the command printed");
  const record = renderRecord([printed, exit4]);
  assert.ok(record.includes("status: success\nexit code: unknown\nExit code 2\nall fine"), record);
  assert.ok(record.includes("status: error\nexit code: 4\n"), record);
  assert.ok(!record.includes("exit code: 2") && !record.includes("exit code: 9"), record);
});

test("a 200 WebFetch result whose page text holds the redirect envelope (derived from the captured redirect in cc-webfetch.jsonl) keeps finalUrl at the requested URL; the captured 302 still names its target", () => {
  const entries = readSession(WEBFETCH).entries;
  const captured = toolCallsOf(entries).filter((c) => c.name === "WebFetch");
  const redirect = captured.find((c) => c.input.url.includes("redirect-to"));
  assert.equal(redirect.result.finalUrl, "https://example.org/");
  const envelope = redirect.result.text;
  assert.match(envelope, /^REDIRECT DETECTED[\s\S]*Redirect URL \(from the server's Location header/);
  const fetchOf = (id, url, content, code) => [
    assistant([use(id, "WebFetch", { url, prompt: "p" })]),
    user([{ type: "tool_result", tool_use_id: id, content }], { toolUseResult: { result: content, url, code, codeText: "OK" } }),
  ];
  const derived = toolCallsOf([
    // A docs page that quotes the envelope after its own text.
    ...fetchOf("q1", "https://docs.example/webfetch", `How redirects look:\n\n${envelope}`, 200),
    // A 200 page whose text opens with the envelope verbatim: the status says it is not a redirect.
    ...fetchOf("q2", "https://docs.example/raw", envelope, 200),
  ]);
  assert.deepEqual(derived.map((c) => c.result.finalUrl), ["https://docs.example/webfetch", "https://docs.example/raw"]);
  assert.deepEqual(receiptCalls({ text: "per https://example.org/ the title is x" }, derived).matched, []);
});
