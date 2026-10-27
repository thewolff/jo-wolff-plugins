// ask.test.mjs — node --test
//
// Every judge here is a FAKE: a printf or a tiny node script standing in for the real judge
// command. The point is to prove the DISPATCH — stdin delivery, placeholder escaping,
// last-JSON parsing, envelope unwrapping, caching, timeout, failure logging — without paying
// a model bill or depending on any CLI being logged in. The harness-budget test waits on a
// real 21s judge, because the budget is only proven by a judge that actually outlasts it.
//
// Run: node --test 'plugins/i-have-audhd/judge/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJudge, parseVerdict } from "./ask.mjs";

function mkstate() {
  return mkdtempSync(join(tmpdir(), "audhd-judge-"));
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
  // The fake answers violation=true only when the caller's context reached its stdin; any other
  // path exits 3, which askJudge reports as an error.
  const fakeJudge =
    `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{` +
    `if(!s.includes("context-on-stdin-7f3a")) process.exit(3);` +
    `process.stdout.write(JSON.stringify({violation:true,reason:"r"}))})'`;
  const r = await askJudge("do-not-batch-by-label", "is it a dump?", "context-on-stdin-7f3a", { judgeCommand: fakeJudge }, { stateDir: state });
  assert.equal(r.error, undefined);
  assert.equal(r.violation, true);
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
  assert.equal(r.violation, true, r.reason); // the fake's reason carries what it received on failure
  assert.equal(r.error, undefined);
});

test("a judge printing banner then verdict parses (the codex shape)", async () => {
  const state = mkstate();
  const r = await askJudge(
    "bad-news-first",
    "q",
    "msg",
    { judgeCommand: `printf '%s\\n' 'header line' '{\"violation\":true,\"reason\":\"probe\"}'` },
    { stateDir: state },
  );
  assert.equal(r.error, undefined);
  assert.equal(r.violation, true);
});

// ─── the cache ───────────────────────────────────────────────────────────────

test("an identical prompt hits the cache; the judge runs once", async () => {
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
  assert.equal(readFileSync(counter, "utf8"), "1");

  // A different context is a different bill.
  const third = await askJudge("conclusion-first", "q", "different message text", cfg, { stateDir: state });
  assert.equal(third.cached, false);
  assert.equal(readFileSync(counter, "utf8"), "2");
});

test("the cache key covers the question: same rule and text, two questions, two judge runs", async () => {
  const state = mkstate();
  const counter = join(state, "count");
  const fakeJudge =
    `node -e 'const fs=require("fs");const n=(fs.existsSync("${counter}")?+fs.readFileSync("${counter}","utf8"):0)+1;` +
    `fs.writeFileSync("${counter}",String(n));` +
    `process.stdout.write(JSON.stringify({violation:n===1,reason:"run "+n}))'`;
  const cfg = { judgeCommand: fakeJudge };
  const first = await askJudge("conclusion-first", "q, framed as section CLAIM", "same section text", cfg, { stateDir: state });
  const second = await askJudge("conclusion-first", "q, unframed", "same section text", cfg, { stateDir: state });
  assert.equal(first.cached, false);
  assert.equal(second.cached, false);
  assert.equal(first.violation, true);
  assert.equal(second.violation, false, "the second question got its own verdict, not the first one's");
  assert.equal(readFileSync(counter, "utf8"), "2");
});

// ─── failure is open and loud ────────────────────────────────────────────────

// A failed judge is "unavailable": it carries no verdict, so no caller can read it as a pass.
const assertUnavailable = (r) => {
  assert.equal(r.unavailable, true, "a failed judge is reported as unavailable");
  assert.equal("violation" in r, false, "a failed judge carries no verdict, never violation:false (a pass)");
};

test("a failing judge's stderr is kept, bounded, in judge-failures.log", async () => {
  const state = mkstate();
  const noise = "x".repeat(5000);
  const cfg = { judgeCommand: `printf '%s' '${noise}' >&2; echo 'codex: not logged in, run codex login' >&2; exit 1` };
  const r = await askJudge("conclusion-first", "q", "msg", cfg, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "judge-exit-1");
  const line = readLog(state).trim();
  assert.match(line, /rule=conclusion-first error=judge-exit-1 stderr=/);
  assert.match(line, /not logged in, run codex login/, "the tail of stderr, where the reason is, survives");
  assert.ok(line.length < 1000, `the stderr kept is bounded (line is ${line.length} chars)`);
});

test("a timeout kills the judge, fails open, and logs it", async () => {
  const state = mkstate();
  const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand: "sleep 5" }, { stateDir: state, timeoutMs: 250 });
  assertUnavailable(r);
  assert.equal(r.error, "judge-timeout");
  assert.match(readLog(state), /rule=conclusion-first error=judge-timeout/);
});

// true once kill(pid, 0) reports ESRCH; polls up to 2s so the kernel can reap the zombie.
const isGone = async (pid) => {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") return true;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// A regression must fail its test, not leave a live process behind the run.
const killQuietly = (pids) => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone: the expected case
    }
  }
};

const readPid = (path) => Number(readFileSync(path, "utf8").trim());

test("a timeout reaps the judge's whole process group: a pipeline stage and a backgrounded child both die", async () => {
  const state = mkstate();
  const bg = join(state, "bg.pid");
  const stage = join(state, "stage.pid");
  // `sleep &` holds the judge's stdout; the exec'd sleep is the first stage of a pipeline.
  const judgeCommand = `sleep 30 & echo $! > '${bg}'; sh -c 'echo $$ > "$0"; exec sleep 30' '${stage}' | cat`;
  const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand }, { stateDir: state, timeoutMs: 750 });
  assert.equal(r.error, "judge-timeout");
  const pids = [readPid(bg), readPid(stage)];
  const gone = await Promise.all(pids.map(isGone));
  killQuietly(pids);
  assert.deepEqual(gone, [true, true], `descendants ${pids.join(", ")} outlived the timeout`);
});

// askJudge in its own node process under `env`: the stop core's shape, a process that must exit
// once its judges settle. Resolves with the result and the wall time until that process exited.
const ASK = new URL("./ask.mjs", import.meta.url).href;
const askInChild = (env, judgeCommand, extraOptions = "") =>
  new Promise((resolve, reject) => {
    const state = mkstate();
    const script =
      `import { askJudge } from ${JSON.stringify(ASK)};\n` +
      `const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand: ${JSON.stringify(judgeCommand)} },` +
      ` { stateDir: ${JSON.stringify(state)}${extraOptions} });\n` +
      `process.stdout.write(JSON.stringify(r));`;
    const started = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve({ result: JSON.parse(out), exitMs: Date.now() - started, state }));
  });

const untaggedEnv = () => {
  const env = { ...process.env };
  delete env.I_HAVE_AUDHD_HARNESS;
  return env;
};

test("a descendant that leaves the judge's group cannot hold the caller open after a timeout", async () => {
  const state = mkstate();
  const escapedPid = join(state, "escaped.pid");
  const escape = join(state, "escape.mjs");
  // A new session of its own (detached), holding the judge's stdout, outliving the script.
  writeFileSync(
    escape,
    `import { spawn } from "node:child_process";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const c = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });\n` +
      `writeFileSync(${JSON.stringify(escapedPid)}, String(c.pid));\n` +
      `c.unref();\n`,
  );
  const judgeCommand = `'${process.execPath}' '${escape}'; sleep 30`;
  const { result, exitMs } = await askInChild(untaggedEnv(), judgeCommand, ", timeoutMs: 1_000");
  const pid = existsSync(escapedPid) ? readPid(escapedPid) : undefined;
  if (pid) killQuietly([pid]);
  assert.ok(pid, "the escaping descendant started");
  assert.equal(result.error, "judge-timeout");
  assert.ok(exitMs < 10_000, `the caller exited ${exitMs}ms after start; the escaped sleep held it open`);
});

test("the harness tag sets the budget: a 21s judge times out under omp and answers untagged", async () => {
  const slowJudge = `sleep 21; printf '{"violation": true, "reason": "slow but sure"}'`;
  const [omp, untagged] = await Promise.all([
    askInChild({ ...untaggedEnv(), I_HAVE_AUDHD_HARNESS: "omp" }, slowJudge),
    askInChild(untaggedEnv(), slowJudge),
  ]);
  assert.equal(omp.result.error, "judge-timeout", "the omp budget cut the judge off");
  assert.ok(omp.exitMs < 21_000, `the omp caller exited at ${omp.exitMs}ms, after the judge would have answered`);
  assert.match(readLog(omp.state), /rule=conclusion-first error=judge-timeout/);
  assert.deepEqual(untagged.result, { violation: true, reason: "slow but sure", cached: false }, "Claude Code's budget still waits for it");
});

test("a non-zero exit fails open and logs the exit code", async () => {
  const state = mkstate();
  const r = await askJudge("bad-news-first", "q", "msg", { judgeCommand: "exit 7" }, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "judge-exit-7");
  assert.match(readLog(state), /rule=bad-news-first error=judge-exit-7/);
});

test("unparseable output fails open and logs it — and is not cached", async () => {
  const state = mkstate();
  const cfg = { judgeCommand: `printf 'I have no thoughts, only vibes.'` };
  const r = await askJudge("restate-resumed-thread", "q", "msg", cfg, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "judge-unparseable");
  assert.match(readLog(state), /judge-unparseable/);
  const cacheDir = join(state, "cache");
  assert.ok(!existsSync(cacheDir) || readFileSync(cacheDir, "utf8") === "", "failures are never cached");
});

test("a missing judgeCommand is reported, not guessed at", async () => {
  const state = mkstate();
  const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand: null }, { stateDir: state });
  assert.deepEqual(r, { unavailable: true, error: "no-judge-command" });
});

test("askJudge never throws, even on a broken command string", async () => {
  const state = mkstate();
  const r = await askJudge("x", "q", "m", { judgeCommand: "definitely-not-a-binary-xyz --flag" }, { stateDir: state });
  assertUnavailable(r);
  assert.ok(r.error, "an error is named");
  assert.match(readLog(state), /rule=x error=/);
});
