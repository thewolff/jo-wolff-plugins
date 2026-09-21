// ask.test.mjs — node --test
//
// Every judge here is a FAKE: a printf or a tiny node script standing in for the real judge
// command. The point is to prove the DISPATCH — stdin delivery, placeholder escaping,
// last-JSON parsing, envelope unwrapping, caching, timeout, failure logging — without paying
// a model bill or depending on any CLI being logged in.
//
// Run: node --test plugins/communication-rules/judge/

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJudge, parseVerdict } from "./ask.mjs";

function mkstate() {
  return mkdtempSync(join(tmpdir(), "commrules-judge-"));
}

const readLog = (dir) => {
  const p = join(dir, "judge-failures.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

// ─── parsing: the LAST JSON object on stdout, envelopes unwrapped ────────────

test("parseVerdict takes the last JSON object, ignoring banner lines before it", () => {
  const out = parseVerdict('session banner noise\n{"violation":true,"reason":"first"}\nmore noise\n{"violation":false,"reason":"second"}\n');
  assert.deepEqual(out, { violation: false, reason: "second" });
});

test("parseVerdict unwraps a result-envelope one level deep", () => {
  const envelope = JSON.stringify({ type: "result", result: '{"violation": true, "reason": "inner"}' });
  assert.deepEqual(parseVerdict(envelope), { violation: true, reason: "inner" });
});

test("parseVerdict ignores objects without the verdict shape, and strings with braces", () => {
  assert.equal(parseVerdict('{"foo": 1} nothing here'), null);
  assert.equal(parseVerdict('{"violation": "yes", "reason": "wrong type"}'), null);
  // Braces inside JSON strings must not fool the span scanner.
  assert.deepEqual(parseVerditSafe('{"note": "a } inside"}, {"violation": false, "reason": "ok"}'), {
    violation: false,
    reason: "ok",
  });
});
function parseVerditSafe(s) {
  return parseVerdict(s);
}

test("parseVerdict on garbage is null, never a throw", () => {
  for (const bad of ["", "   ", "not json", "{", '{"violation":true', undefined, null]) {
    assert.equal(parseVerdict(bad), null);
  }
});

// ─── dispatch: the two command forms ─────────────────────────────────────────

test("no-placeholder form receives the prompt on stdin", async () => {
  const state = mkstate();
  const fakeJudge =
    `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{` +
    `if(!s.includes("Rule: do-not-batch-by-label")) process.exit(3);` +
    `process.stdout.write(JSON.stringify({violation:false,reason:"prompt seen on stdin"}))})'`;
  const r = await askJudge("do-not-batch-by-label", "is it a dump?", "the message", { judgeCommand: fakeJudge }, { stateDir: state });
  assert.equal(r.violation, false);
  assert.equal(r.reason, "prompt seen on stdin");
  assert.equal(r.error, undefined);
});

test("placeholder form shell-escapes the prompt, apostrophes intact", async () => {
  const state = mkstate();
  const contextText = "this context isn't plain — it has 'single quotes' and $dollar signs";
  // A script FILE, not -e: the test's own apostrophes must not fight the shell quoting of
  // the command line; the placeholder substitution under test is the only quoting in play.
  const script = join(state, "fake-judge.mjs");
  writeFileSync(
    script,
    [
      'const a = process.argv[2] ?? "";',
      'const held = a.includes("isn\'t plain") && a.includes("\'single quotes\'") && a.includes("$dollar");',
      'process.stdout.write(JSON.stringify({ violation: held, reason: held ? "escaping held" : "GOT: " + a }));',
      "",
    ].join("\n"),
  );
  const r = await askJudge(
    "conclusion-first",
    "q",
    contextText,
    { judgeCommand: `node ${script} {prompt}` },
    { stateDir: state },
  );
  assert.equal(r.reason, "escaping held");
  assert.equal(r.error, undefined);
});

test("a judge printing banner then verdict parses (the codex shape)", async () => {
  const state = mkstate();
  const r = await askJudge(
    "bad-news-first",
    "q",
    "msg",
    { judgeCommand: `printf '%s\\n' 'header line' '{\"violation\":false,\"reason\":\"probe\"}'` },
    { stateDir: state },
  );
  assert.deepEqual({ violation: r.violation, reason: r.reason }, { violation: false, reason: "probe" });
});

// ─── the cache ───────────────────────────────────────────────────────────────

test("an identical rule+context hits the cache; the judge runs once", async () => {
  const state = mkstate();
  const counter = join(state, "count");
  const fakeJudge =
    `node -e 'const fs=require("fs");const n=(fs.existsSync("${counter}")?+fs.readFileSync("${counter}","utf8"):0)+1;` +
    `fs.writeFileSync("${counter}",String(n));` +
    `process.stdout.write(JSON.stringify({violation:false,reason:"run "+n}))'`;
  const cfg = { judgeCommand: fakeJudge };
  const first = await askJudge("conclusion-first", "q", "same message text", cfg, { stateDir: state });
  const second = await askJudge("conclusion-first", "q", "same message text", cfg, { stateDir: state });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.reason, "run 1");
  assert.equal(readFileSync(counter, "utf8"), "1");

  // A different context is a different bill.
  const third = await askJudge("conclusion-first", "q", "different message text", cfg, { stateDir: state });
  assert.equal(third.cached, false);
  assert.equal(readFileSync(counter, "utf8"), "2");
});

// ─── failure is open and loud ────────────────────────────────────────────────

test("a timeout kills the judge, fails open, and logs it", async () => {
  const state = mkstate();
  const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand: "sleep 5" }, { stateDir: state, timeoutMs: 250 });
  assert.equal(r.violation, false);
  assert.equal(r.error, "judge-timeout");
  assert.match(readLog(state), /rule=conclusion-first error=judge-timeout/);
});

test("a non-zero exit fails open and logs the exit code", async () => {
  const state = mkstate();
  const r = await askJudge("bad-news-first", "q", "msg", { judgeCommand: "exit 7" }, { stateDir: state });
  assert.equal(r.violation, false);
  assert.equal(r.error, "judge-exit-7");
  assert.match(readLog(state), /rule=bad-news-first error=judge-exit-7/);
});

test("unparseable output fails open and logs it — and is not cached", async () => {
  const state = mkstate();
  const cfg = { judgeCommand: `printf 'I have no thoughts, only vibes.'` };
  const r = await askJudge("restate-resumed-thread", "q", "msg", cfg, { stateDir: state });
  assert.equal(r.violation, false);
  assert.equal(r.error, "judge-unparseable");
  assert.match(readLog(state), /judge-unparseable/);
  const cacheDir = join(state, "cache");
  assert.ok(!existsSync(cacheDir) || readFileSync(cacheDir, "utf8") === "", "failures are never cached");
});

test("a missing judgeCommand is reported, not guessed at", async () => {
  const state = mkstate();
  const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand: null }, { stateDir: state });
  assert.deepEqual(r, { violation: false, error: "no-judge-command" });
});

test("askJudge never throws, even on a broken command string", async () => {
  const state = mkstate();
  const r = await askJudge("x", "q", "m", { judgeCommand: "definitely-not-a-binary-xyz --flag" }, { stateDir: state });
  assert.equal(r.violation, false);
  assert.ok(r.error, "an error is named");
  assert.match(readLog(state), /rule=x error=/);
});
