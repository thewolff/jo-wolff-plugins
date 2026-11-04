// ask.test.mjs — node --test
//
// Every judge here is a FAKE: a printf or a tiny node script standing in for the real judge
// command. The point is to prove what is i-have-audhd's own around plugin-kit's shared dispatch
// (../lib/judge.mjs, whose stdin/placeholder forms, failure classes and process-group reaping
// are the kit's tests' to prove): the command's resolution (the profile's override, then the
// shared file), the strict verdict shape, caching, the harness budget, the failure line, and
// that the stop core's process exits once its judges settle — without paying a model bill or
// depending on any CLI being logged in. The harness-budget test waits on a real 21s judge,
// because the budget is only proven by a judge that actually outlasts it.
//
// Run: node --test 'plugins/i-have-audhd/judge/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJudge, parseVerdict, resolveJudge, judgeSources } from "./ask.mjs";

function mkstate() {
  return mkdtempSync(join(tmpdir(), "audhd-judge-"));
}

// An env with none of this machine's judge settings in it: a fresh HOME (no profile, no
// ~/.config/judge), XDG_CONFIG_HOME unset, and no harness tag. `shared` is where the shared
// file would be; `put` writes it.
function box(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "audhd-judge-home-"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: "", I_HAVE_AUDHD_PROFILE: "", I_HAVE_AUDHD_HARNESS: "", ...extra };
  const shared = join(home, ".config", "judge", "config.json");
  const put = (text) => {
    mkdirSync(join(home, ".config", "judge"), { recursive: true });
    writeFileSync(shared, typeof text === "string" ? text : JSON.stringify(text));
  };
  return { home, env, shared, put };
}

const readLog = (dir) => {
  const p = join(dir, "judge-failures.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

// A fake judge that counts its runs in `counter` and answers violation=false with the run number.
const countingJudge = (counter) =>
  `node -e 'const fs=require("fs");const n=(fs.existsSync("${counter}")?+fs.readFileSync("${counter}","utf8"):0)+1;` +
  `fs.writeFileSync("${counter}",String(n));` +
  `process.stdout.write(JSON.stringify({violation:false,reason:"run "+n}))'`;

// ─── parsing: the verdict shape on top of the kit's last-JSON-object ─────────

test("parseVerdict takes the last JSON object, ignoring banner lines before it", () => {
  const out = parseVerdict('session banner noise\n{"violation":true,"reason":"first"}\nmore noise\n{"violation":false,"reason":"second"}\n');
  assert.deepEqual(out, { violation: false, reason: "second" });
});

test("parseVerdict unwraps a result-envelope, with and without the kit's type:result tag", () => {
  const tagged = JSON.stringify({ type: "result", result: '{"violation": true, "reason": "inner"}' });
  assert.deepEqual(parseVerdict(tagged), { violation: true, reason: "inner" });
  const bare = JSON.stringify({ result: 'Here you go:\n{"violation": false, "reason": "bare envelope"}' });
  assert.deepEqual(parseVerdict(bare), { violation: false, reason: "bare envelope" });
});

test("parseVerdict rejects a last object without the strict verdict shape, and garbage, never a throw", () => {
  assert.equal(parseVerdict('{"foo": 1} nothing here'), null);
  assert.equal(parseVerdict('{"violation": "yes", "reason": "wrong type"}'), null);
  assert.equal(parseVerdict('{"violation": true, "reason": "ok"}\n{"usage": 5}'), null, "the LAST object is the verdict, or there is none");
  for (const bad of ["", "   ", "not json", "{", '{"violation":true', undefined, null]) {
    assert.equal(parseVerdict(bad), null);
  }
});

// ─── resolution: the profile's override, then the shared file ────────────────

test("resolveJudge: the profile key wins over the shared file; null or absent falls through to it; nothing anywhere is null", () => {
  const b = box();
  assert.equal(resolveJudge({ judgeCommand: null }, { env: b.env }), null);
  b.put({ command: "shared-judge", timeoutMs: 5 });
  const fromShared = resolveJudge({ judgeCommand: null }, { env: b.env });
  assert.equal(fromShared.command, "shared-judge");
  assert.equal(fromShared.source, b.shared);
  assert.equal(fromShared.timeoutMs, 30_000, "the budget is the harness's, never the shared file's timeoutMs");
  assert.equal(resolveJudge({}, { env: b.env }).command, "shared-judge");
  const own = resolveJudge({ judgeCommand: "own-judge" }, { env: b.env });
  assert.equal(own.command, "own-judge");
  assert.equal(own.source, `enforcement.judgeCommand in ${join(b.home, ".claude", "i-have-audhd.json")}`);
  assert.equal(resolveJudge({ judgeCommand: "own" }, { env: { ...b.env, I_HAVE_AUDHD_HARNESS: "omp" } }).timeoutMs, 20_000);
  assert.equal(resolveJudge({ judgeCommand: "own" }, { env: b.env, timeoutMs: 250 }).timeoutMs, 250);
});

test("resolveJudge: a malformed shared file ends the search; judgeSources names it", () => {
  const b = box();
  b.put("{ not json");
  assert.equal(resolveJudge({ judgeCommand: null }, { env: b.env }), null);
  assert.equal(resolveJudge({ judgeCommand: "own-judge" }, { env: b.env }).command, "own-judge", "the override still wins");
  const sources = judgeSources(b.env);
  assert.equal(sources.shared, b.shared);
  assert.equal(sources.profile, join(b.home, ".claude", "i-have-audhd.json"));
  assert.match(sources.malformed, new RegExp(`^${b.shared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
  assert.equal(judgeSources(box().env).malformed, null);
});

test("askJudge runs the shared file's command when the profile has none, and the profile's when it has one", async () => {
  const b = box();
  const state = mkstate();
  const sharedCounter = join(state, "shared-count");
  const ownCounter = join(state, "own-count");
  b.put({ command: countingJudge(sharedCounter) });
  const viaShared = await askJudge("conclusion-first", "q", "msg one", { judgeCommand: null }, { stateDir: state, env: b.env });
  assert.deepEqual(viaShared, { violation: false, reason: "run 1", cached: false });
  assert.equal(readFileSync(sharedCounter, "utf8"), "1");
  const viaOwn = await askJudge("conclusion-first", "q", "msg two", { judgeCommand: countingJudge(ownCounter) }, { stateDir: state, env: b.env });
  assert.deepEqual(viaOwn, { violation: false, reason: "run 1", cached: false });
  assert.equal(readFileSync(ownCounter, "utf8"), "1");
  assert.equal(readFileSync(sharedCounter, "utf8"), "1", "the shared judge did not run for the overridden call");
});

test("the judge's environment carries the two off switches, so a judge that is itself a Claude Code or OMP session runs none of this plugin's hooks", async () => {
  const b = box();
  const state = mkstate();
  const seen = join(state, "env.json");
  const judge = `node -e 'require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({e: process.env.I_HAVE_AUDHD_ENFORCE, i: process.env.I_HAVE_AUDHD_INJECT}));process.stdout.write(JSON.stringify({violation:false,reason:"r"}))'`;
  b.put({ command: judge });
  const r = await askJudge("conclusion-first", "q", "msg", {}, { stateDir: state, env: b.env });
  assert.equal(r.violation, false);
  assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), { e: "off", i: "off" });
});

// ─── the prompt reaches the kit's dispatch in both forms ─────────────────────

test("the prompt reaches the judge: on stdin without a placeholder, shell-escaped in the argument with one", async () => {
  const state = mkstate();
  // Stdin form: the fake answers violation=true only when the caller's context reached its stdin;
  // any other path exits 3, which askJudge reports as an error.
  const stdinJudge =
    `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{` +
    `if(!s.includes("context-on-stdin-7f3a")) process.exit(3);` +
    `process.stdout.write(JSON.stringify({violation:true,reason:"r"}))})'`;
  const viaStdin = await askJudge("do-not-batch-by-label", "is it a dump?", "context-on-stdin-7f3a", { judgeCommand: stdinJudge }, { stateDir: state });
  assert.equal(viaStdin.error, undefined);
  assert.equal(viaStdin.violation, true);

  // Placeholder form: a script FILE, not -e, so the test's own apostrophes do not fight the
  // shell quoting of the command line; the substitution under test is the only quoting in play.
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
  const contextText = "this context isn't plain — it has 'single quotes' and $dollar signs";
  const viaArg = await askJudge("conclusion-first", "q", contextText, { judgeCommand: `node ${script} {prompt}` }, { stateDir: state });
  assert.equal(viaArg.violation, true, viaArg.reason); // the fake's reason carries what it received on failure
  assert.equal(viaArg.error, undefined);
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
  const cfg = { judgeCommand: countingJudge(counter) };
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

test("a failing judge's stderr is kept, bounded, in judge-failures.log; the line names the kit's error, its detail and the command's source", async () => {
  const state = mkstate();
  const noise = "x".repeat(5000);
  const cfg = { judgeCommand: `printf '%s' '${noise}' >&2; echo 'codex: not logged in, run codex login' >&2; exit 1` };
  const r = await askJudge("conclusion-first", "q", "msg", cfg, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "nonzero");
  assert.equal(r.detail, "exit 1");
  assert.match(r.source, /^enforcement\.judgeCommand in /);
  const line = readLog(state).trim();
  assert.match(line, /rule=conclusion-first error=nonzero cause=no-credential .* detail="exit 1" source="enforcement\.judgeCommand in [^"]+" stderr=/);
  assert.match(line, /not logged in, run codex login/, "the tail of stderr, where the reason is, survives");
  assert.ok(line.length < 1000, `the stderr kept is bounded (line is ${line.length} chars)`);
});

test("a timeout kills the judge, fails open, and logs it", async () => {
  const state = mkstate();
  const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand: "sleep 5" }, { stateDir: state, timeoutMs: 250 });
  assertUnavailable(r);
  assert.equal(r.error, "timeout");
  assert.equal(r.detail, "no exit within 250 ms");
  assert.match(readLog(state), /rule=conclusion-first error=timeout cause=hook-deadline .* budgetMs=250 /);
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
  assert.equal(result.error, "timeout");
  assert.ok(exitMs < 10_000, `the caller exited ${exitMs}ms after start; the escaped sleep held it open`);
});

test("the harness tag sets the budget: a 21s judge times out under omp and answers untagged", async () => {
  const slowJudge = `sleep 21; printf '{"violation": true, "reason": "slow but sure"}'`;
  const [omp, untagged] = await Promise.all([
    askInChild({ ...untaggedEnv(), I_HAVE_AUDHD_HARNESS: "omp" }, slowJudge),
    askInChild(untaggedEnv(), slowJudge),
  ]);
  assert.equal(omp.result.error, "timeout", "the omp budget cut the judge off");
  assert.ok(omp.exitMs < 21_000, `the omp caller exited at ${omp.exitMs}ms, after the judge would have answered`);
  assert.match(readLog(omp.state), /rule=conclusion-first error=timeout cause=hook-deadline .* budgetMs=20000 /);
  assert.deepEqual(untagged.result, { violation: true, reason: "slow but sure", cached: false }, "Claude Code's budget still waits for it");
});

test("a non-zero exit fails open and logs the exit status as the kit's detail", async () => {
  const state = mkstate();
  const r = await askJudge("bad-news-first", "q", "msg", { judgeCommand: "exit 7" }, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "nonzero");
  assert.equal(r.detail, "exit 7");
  assert.match(readLog(state), /rule=bad-news-first error=nonzero cause=other .* detail="exit 7"/);
});

test("unparseable output fails open and logs it — and is not cached", async () => {
  const state = mkstate();
  const cfg = { judgeCommand: `printf 'I have no thoughts, only vibes.'` };
  const r = await askJudge("restate-resumed-thread", "q", "msg", cfg, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "unparseable");
  assert.match(readLog(state), /error=unparseable/);
  const cacheDir = join(state, "cache");
  assert.ok(!existsSync(cacheDir) || !readdirSync(cacheDir).some((f) => f.endsWith(".json")), "failures are never cached as verdicts");
  assert.match(readLog(state), /cause=bad-json .* stdout="I have no thoughts, only vibes\."/, "the stdout tail is on the line");
});

test("a verdict-shaped object that is not the LAST object on stdout is unparseable, not a verdict", async () => {
  const state = mkstate();
  const cfg = { judgeCommand: `printf '%s\\n' '{"violation": true, "reason": "early"}' '{"usage": 5}'` };
  const r = await askJudge("conclusion-first", "q", "msg", cfg, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "unparseable");
});

test("no judge anywhere is reported, not guessed at", async () => {
  const state = mkstate();
  const r = await askJudge("conclusion-first", "q", "msg", { judgeCommand: null }, { stateDir: state, env: box().env });
  assert.deepEqual(r, { unavailable: true, error: "no-judge-command" });
  assert.equal(readLog(state), "", "nothing was dispatched, so nothing failed");
});

test("askJudge never throws, even on a broken command string", async () => {
  const state = mkstate();
  const r = await askJudge("x", "q", "m", { judgeCommand: "definitely-not-a-binary-xyz --flag" }, { stateDir: state });
  assertUnavailable(r);
  assert.equal(r.error, "nonzero");
  assert.match(readLog(state), /rule=x error=nonzero /);
});
