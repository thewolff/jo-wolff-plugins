import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ERRORS_LOG_MAX, errorsLogPath, logError, readStdin, respond } from "./hookio.mjs";

const hook = (handle = () => null) => ({ event: "PreToolUse", allowed: "this call was allowed", handle });
const ok = (text) => ({ text, timedOut: false, error: null });

test("respond: a JSON object goes to handle and its output comes back as is", () => {
  let seen = null;
  const out = respond(hook((input) => { seen = input; return { decision: "x" }; }), ok('{"tool_name":"Edit"}'));
  assert.deepEqual(seen, { tool_name: "Edit" });
  assert.deepEqual(out, { decision: "x" });
  assert.equal(respond(hook(), ok("{}")), null);
});

test("respond: empty, malformed, non-object, timed-out and unreadable stdin allow with a one-line warning naming the reason", () => {
  const cases = [
    [ok(""), /got empty stdin, not a PreToolUse payload/],
    [ok("  \n"), /got empty stdin/],
    [ok("not json"), /got stdin that is not JSON \(/],
    [ok("[1,2]"), /payload that is not a JSON object/],
    [ok("null"), /payload that is not a JSON object/],
    [{ text: '{"a"', timedOut: true, error: null }, /did not get a closed stdin within 2 s/],
    [{ text: "", timedOut: false, error: new Error("EIO") }, /could not read stdin \(EIO\)/],
  ];
  for (const [stdin, re] of cases) {
    const out = respond(hook(() => assert.fail("handle must not run")), stdin);
    assert.match(out.systemMessage, /^pattern-check: the PreToolUse hook /);
    assert.match(out.systemMessage, re);
    assert.match(out.systemMessage, /; this call was allowed$/);
    assert.equal(out.systemMessage.includes("\n"), false);
    assert.equal(out.hookSpecificOutput, undefined);
  }
});

test("respond: a throwing handle allows with the error message", () => {
  const out = respond(hook(() => { throw new Error("boom"); }), ok("{}"));
  assert.match(out.systemMessage, /^pattern-check: .*PreToolUse.*\(boom\).*allowed$/);
  assert.equal(out.systemMessage.includes("\n"), false);
  assert.equal(out.hookSpecificOutput, undefined);
});

test("logError appends one line with the hook file and reason, flattening newlines, and rotates past the cap", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pattern-check-hookio-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "nested", "errors.log");
  logError(file, "pattern-check-stop.mjs", "config x is not valid JSON\nsecond line", new Date("2026-11-03T00:00:00Z"));
  assert.equal(readFileSync(file, "utf8"), "2026-11-03T00:00:00.000Z pattern-check-stop.mjs config x is not valid JSON second line\n");
  writeFileSync(file, "x".repeat(ERRORS_LOG_MAX + 1));
  logError(file, "h", "after rotation");
  assert.equal(existsSync(`${file}.1`), true);
  assert.match(readFileSync(file, "utf8"), /^\S+ h after rotation\n$/);
});

test("errorsLogPath lives in the state directory", () => {
  assert.equal(errorsLogPath({ XDG_STATE_HOME: "/s" }, "/home/u"), "/s/pattern-check/errors.log");
  assert.equal(errorsLogPath({}, "/home/u"), "/home/u/.local/state/pattern-check/errors.log");
});

test("readStdin returns the text at end, and what it has at the deadline when stdin stays open", async () => {
  const closed = new PassThrough();
  const p = readStdin(1000, closed);
  closed.end('{"a":1}');
  assert.deepEqual(await p, { text: '{"a":1}', timedOut: false, error: null });
  const open = new PassThrough();
  open.write("{");
  const started = Date.now();
  const r = await readStdin(50, open);
  assert.equal(r.timedOut, true);
  assert.equal(r.text, "{");
  assert.ok(Date.now() - started < 1000);
});
