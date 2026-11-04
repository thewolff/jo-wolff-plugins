// test/probe.test.mjs — judge(), probe(), heal(), check(), runCtx() and needsYouLine() against
// captured ctx 2.3.0 output (test/fixtures, captured 2026-11-04; see fixtures/README.md). The
// derived cases (supervisor install_failed, stale core_refresh, a status that is not "running",
// a stamp out of range or in the future) change exactly one field of the healthy capture, named
// here, because ctx could not be made to print them without breaking a real installation; stale
// and future are also reachable by moving `now`. runCtx's hard bound is proved on a real child
// that ignores SIGTERM, with a grandchild, and never on ctx.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, probe, heal, check, runCtx, needsYouLine, ctxEnv, age, validMs, STALE_MS, SKEW_MS, STATUS_ARGV, MODE_ARGV, HEAL_ARGV, FIX, FIX_MISSING, SEMANTIC_FIX, SEMANTIC_STATUS, LINE_MAX } from "../lib/probe.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(join(FIX_DIR, name), "utf8");
const HEALTHY = fixture("ctx-daemon-status.txt");
const NOT_RUNNING = fixture("ctx-daemon-status-not-running.txt");
const BUDGET_EXHAUSTED = fixture("ctx-daemon-status-semantic-budget-exhausted.txt");
const BUDGET_EXHAUSTED_0300 = fixture("ctx-daemon-status-semantic-budget-exhausted-0300.txt");
const MODE = fixture("ctx-index-mode.txt");
const HEALED = fixture("ctx-index-mode-auto.txt");
const HEAL_SUPPRESSED = fixture("ctx-index-mode-auto.unavailable.txt");
const CTX_MISSING = fixture("ctx-daemon-status.unavailable.txt");

const HEALTHY_LAST_RUN = JSON.parse(HEALTHY).daemon.jobs.core_refresh.last_run_at_ms;
/** A `now` one minute after the healthy capture's core_refresh. */
const NOW = HEALTHY_LAST_RUN + 60_000;

const good = (stdout) => ({ code: 0, stdout, stderr: "" });
/** The healthy capture with one field changed. */
function mutated(edit) {
  const j = JSON.parse(HEALTHY);
  edit(j);
  return JSON.stringify(j);
}
/** A capture with its semantic_index block edited. */
function semanticEdited(text, edit) {
  const j = JSON.parse(text);
  edit(j.daemon.jobs.semantic_index);
  return JSON.stringify(j);
}
/** One minute after a capture's own core_refresh. */
const after = (text) => JSON.parse(text).daemon.jobs.core_refresh.last_run_at_ms + 60_000;

test("ctxEnv removes CI and nothing else", () => {
  assert.deepEqual(ctxEnv({ CI: "true", HOME: "/Users/example", PATH: "/usr/bin" }), { HOME: "/Users/example", PATH: "/usr/bin" });
  assert.deepEqual(ctxEnv({ HOME: "/Users/example" }), { HOME: "/Users/example" });
});

test("age renders seconds, minutes, hours", () => {
  assert.equal(age(41_000), "41s");
  assert.equal(age(3 * 60_000), "3m");
  assert.equal(age(125 * 60_000), "2h 5m");
  assert.equal(age(STALE_MS), "2h");
  assert.equal(age(-5), "0s");
});

test("healthy capture: ok, with the fields read", () => {
  const r = judge(good(HEALTHY), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.deepEqual(r.fields, { running: true, status: "running", pid: 1706, supervisor: "installed", lastRunAtMs: HEALTHY_LAST_RUN, semanticEnabled: true, semanticStatus: "ready" });
  assert.match(r.summary, /^daemon running \(pid 1706\), supervisor installed, core_refresh 1m ago, semantic index ready$/);
});

test("budget_exhausted is the throttled indexer resting (captures 2026-11-04 13:39 and 03:00: last_run_status budget_exhausted, runtime_active true, no last_error): ok", () => {
  for (const [name, text] of [["13:39", BUDGET_EXHAUSTED], ["03:00", BUDGET_EXHAUSTED_0300]]) {
    const r = judge(good(text), after(text));
    assert.equal(r.ok, true, name);
    assert.equal(r.reason, null, name);
    assert.deepEqual({ semanticEnabled: r.fields.semanticEnabled, semanticStatus: r.fields.semanticStatus }, { semanticEnabled: true, semanticStatus: "budget_exhausted" }, name);
    assert.match(r.summary, /, semantic index budget_exhausted \(throttled catch-up, not a failure\)$/, name);
  }
  const lastRunReady = judge(good(semanticEdited(BUDGET_EXHAUSTED, (s) => (s.last_run_status = "ready"))), after(BUDGET_EXHAUSTED));
  assert.equal(lastRunReady.ok, true, "budget_exhausted after a ready last run: ok");
});

test("budget_exhausted without the resting marks fails naming the last run: a failed last run, runtime_active false, a last_error, no last_run_status", () => {
  const failedRun = judge(good(semanticEdited(BUDGET_EXHAUSTED, (s) => (s.last_run_status = "failed"))), after(BUDGET_EXHAUSTED));
  assert.equal(failedRun.ok, false);
  assert.equal(failedRun.reason, 'the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = "budget_exhausted", last run "failed")');
  assert.equal(failedRun.fix, SEMANTIC_FIX);
  assert.equal(failedRun.healable, false);
  const line = needsYouLine(failedRun);
  assert.equal(line, 'ctx-watch: the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = "budget_exhausted", last run "failed"); fix: `ctx semantic enable --wait`');
  assert.ok(line.length <= LINE_MAX);
  for (const [what, edit] of [
    ["runtime_active false", (s) => (s.runtime_active = false)],
    ["a last_error", (s) => (s.last_error = "semantic indexing failed")],
    ["no last_run_status", (s) => delete s.last_run_status],
  ]) {
    const r = judge(good(semanticEdited(BUDGET_EXHAUSTED, edit)), after(BUDGET_EXHAUSTED));
    assert.equal(r.ok, false, what);
    assert.equal(r.fix, SEMANTIC_FIX, what);
  }
});

test("semantic rows: a reason is quoted when ctx gives one; every status but ready and a resting budget_exhausted fails; the daemon rows come first", () => {
  const r = judge(good(mutated((j) => ((j.daemon.jobs.semantic_index.status = "pending"), (j.daemon.jobs.semantic_index.reason = "daemon_config_reload_pending")))), NOW);
  assert.equal(r.reason, 'the ctx semantic index is not ready (.daemon.jobs.semantic_index.status = "pending", reason = "daemon_config_reload_pending")');
  for (const status of ["failed", "unknown", "disabled", undefined]) {
    const s = judge(good(mutated((j) => (status === undefined ? delete j.daemon.jobs.semantic_index.status : (j.daemon.jobs.semantic_index.status = status)))), NOW);
    assert.equal(s.ok, false, `status ${status}`);
    assert.equal(s.fix, SEMANTIC_FIX);
  }
  const down = judge(good(mutated((j) => ((j.daemon.running = false), (j.daemon.jobs.semantic_index.status = "failed")))), NOW);
  assert.match(down.reason, /^the ctx daemon is not running/, "one line: the daemon's, not the semantic one");
  assert.equal(down.healable, true);
});

test("semantic search not enabled is a pass (nothing to watch); the block missing is a failure naming it, fix `ctx semantic status`", () => {
  const off = judge(good(mutated((j) => ((j.daemon.jobs.semantic_index.semantic_enabled = false), (j.daemon.jobs.semantic_index.status = "disabled")))), NOW);
  assert.equal(off.ok, true);
  assert.match(off.summary, /semantic search not enabled$/);
  const missing = judge(good(mutated((j) => delete j.daemon.jobs.semantic_index)), NOW);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "`ctx daemon status --format json` has no .daemon.jobs.semantic_index");
  assert.equal(missing.fix, SEMANTIC_STATUS);
  assert.equal(missing.healable, false);
});

test("check: a semantic failure runs no heal (no `ctx index mode` spawn) and says why", () => {
  const seen = [];
  const FAILED_RUN = semanticEdited(BUDGET_EXHAUSTED, (s) => (s.last_run_status = "failed"));
  const r = check({ run: (argv) => (seen.push(argv.slice(1).join(" ")), good(FAILED_RUN)), now: () => after(BUDGET_EXHAUSTED), exists: () => true });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, ["daemon status --format json"]);
  assert.equal(r.healed.attempted, false);
  assert.match(r.healed.detail, /^not attempted: the daemon is running; `ctx index mode auto` does not touch the semantic index$/);
  assert.equal(r.first, null);
  assert.equal(r.timedOut, false);
});

test("running=false capture (a killed daemon, status stale_lock): fails naming .daemon.running and .daemon.status", () => {
  const r = judge(good(NOT_RUNNING), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock")');
  assert.equal(r.fix, FIX);
  assert.equal(r.fields.supervisor, "fallback");
});

test("a status that is not \"running\" is not running, whatever .daemon.running says (missing, stopped, stale_lock)", () => {
  for (const [status, want] of [[undefined, "null"], ["stopped", '"stopped"'], ["stale_lock", '"stale_lock"']]) {
    const r = judge(good(mutated((j) => (status === undefined ? delete j.daemon.status : (j.daemon.status = status)))), NOW);
    assert.equal(r.ok, false, `status ${want}`);
    assert.equal(r.reason, `the ctx daemon is not running (.daemon.running = true, .daemon.status = ${want})`);
    assert.equal(r.fields.running, true, "every other field is the healthy one");
  }
});

test("supervisor install_failed (healthy capture, .daemon.supervisor.status edited): fails naming the field", () => {
  const r = judge(good(mutated((j) => (j.daemon.supervisor.status = "install_failed"))), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'the ctx supervisor is not installed (.daemon.supervisor.status = "install_failed"): launchd will not restart the daemon');
  assert.equal(r.fields.running, true);
});

test("a supervisor field that is missing is 'not installed' too", () => {
  const r = judge(good(mutated((j) => delete j.daemon.supervisor)), NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason, /\.daemon\.supervisor\.status = null/);
});

test("stale core_refresh: fails past 2 h, by moving now and by editing the field", () => {
  const edge = judge(good(HEALTHY), HEALTHY_LAST_RUN + STALE_MS);
  assert.equal(edge.ok, true, "exactly 2 h is not over 2 h");
  const late = judge(good(HEALTHY), HEALTHY_LAST_RUN + STALE_MS + 60_000);
  assert.equal(late.ok, false);
  assert.match(late.reason, /^the ctx daemon runs but core_refresh last ran 2h 1m ago \(\.daemon\.jobs\.core_refresh\.last_run_at_ms = \d{4}-\d\d-\d\dT.*; over 2h\)$/);
  const edited = judge(good(mutated((j) => (j.daemon.jobs.core_refresh.last_run_at_ms = NOW - 3 * 3_600_000))), NOW);
  assert.equal(edited.ok, false);
  assert.match(edited.reason, /core_refresh last ran 3h ago/);
});

test("a missing last_run_at_ms is a failure that names the field", () => {
  const r = judge(good(mutated((j) => delete j.daemon.jobs.core_refresh.last_run_at_ms)), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "`ctx daemon status --format json` has no .daemon.jobs.core_refresh.last_run_at_ms");
  const nul = judge(good(mutated((j) => (j.daemon.jobs.core_refresh.last_run_at_ms = null))), NOW);
  assert.equal(nul.reason, r.reason);
});

test("a last_run_at_ms that is not whole epoch milliseconds is a failing probe naming the field and the value, never a throw", () => {
  for (const bad of [-1e100, -1, 1.5, 9e15, "1700000000000", true]) {
    const r = judge(good(mutated((j) => (j.daemon.jobs.core_refresh.last_run_at_ms = bad))), NOW);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.reason, `\`ctx daemon status --format json\` has an invalid .daemon.jobs.core_refresh.last_run_at_ms (${JSON.stringify(bad)}: not whole epoch milliseconds)`);
    assert.doesNotThrow(() => needsYouLine(r));
  }
  assert.equal(validMs(0), true);
  assert.equal(validMs(8.64e15), true);
  assert.equal(validMs(8.64e15 + 2), false);
  assert.equal(validMs(NaN), false);
});

test("a stamp more than 5 min ahead of this clock is `core_refresh in the future`; inside the skew it is fresh", () => {
  assert.equal(SKEW_MS, 300_000);
  const inside = judge(good(HEALTHY), HEALTHY_LAST_RUN - SKEW_MS);
  assert.equal(inside.ok, true, "exactly 5 min ahead is allowed skew");
  const ahead = judge(good(HEALTHY), HEALTHY_LAST_RUN - SKEW_MS - 60_000);
  assert.equal(ahead.ok, false);
  assert.match(ahead.reason, /^core_refresh in the future \(\.daemon\.jobs\.core_refresh\.last_run_at_ms = \d{4}-.*Z, 6m ahead of this clock; over 5m of skew\)$/);
  const far = judge(good(mutated((j) => (j.daemon.jobs.core_refresh.last_run_at_ms = NOW + 365 * 86_400_000))), NOW);
  assert.equal(far.ok, false);
  assert.match(far.reason, /^core_refresh in the future/);
  assert.equal(far.fix, FIX);
});

test("non-JSON output: fails with the exit code and the first line", () => {
  const r = judge({ code: 1, stdout: "", stderr: "Error: something went wrong\nmore" }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "`ctx daemon status --format json` printed no JSON (exit 1): Error: something went wrong");
  const empty = judge({ code: 0, stdout: "", stderr: "" }, NOW);
  assert.equal(empty.reason, "`ctx daemon status --format json` printed no JSON (exit 0): (no output)");
  const noDaemon = judge(good('{"schema_version":1}'), NOW);
  assert.equal(noDaemon.reason, "`ctx daemon status --format json` has no .daemon");
});

test("ctx missing: the spawn error is the reason and the fix is the install doc; a pinned path that is gone says so", () => {
  const r = judge({ code: null, stdout: "", stderr: "", error: "ctx is not on PATH" }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ctx could not run: ctx is not on PATH");
  assert.equal(r.fix, FIX_MISSING);
  assert.match(CTX_MISSING, /No such file or directory/, "the unavailable capture is the shell's ctx-missing line");
  const slow = judge({ code: null, stdout: "", stderr: "", error: "ctx daemon status --format json did not answer in 10 s" }, NOW);
  assert.equal(slow.reason, "ctx could not run: ctx daemon status --format json did not answer in 10 s");
  assert.equal(slow.fix, FIX);
  const gone = judge(runCtx(["/Users/example/.local/bin/ctx", "daemon", "status"], { PATH: "/usr/bin" }, 1_000), NOW);
  assert.equal(gone.reason, "ctx could not run: /Users/example/.local/bin/ctx does not exist (pinned at install; run install again)");
  assert.equal(gone.fix, FIX_MISSING);
});

test("runCtx: a child that ignores SIGTERM is killed at the bound, and so is its process group", async () => {
  const ignoring = "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)";
  const t = Date.now();
  const r = runCtx([process.execPath, "-e", ignoring], process.env, 300);
  const took = Date.now() - t;
  assert.ok(took < 2_000, `returned in ${took} ms`);
  assert.equal(r.code, null);
  assert.match(r.error, / did not answer in 0\.3 s$/);

  // The child starts a grandchild that also ignores SIGTERM, prints its pid, then hangs.
  const withGrandchild = `const {spawn}=require("node:child_process");const g=spawn(process.execPath,["-e",${JSON.stringify(ignoring)}],{stdio:"ignore"});console.log(g.pid);${ignoring}`;
  const r2 = runCtx([process.execPath, "-e", withGrandchild], process.env, 500);
  assert.match(r2.error, / did not answer in 0\.5 s$/);
  const gpid = Number(r2.stdout.trim());
  assert.ok(gpid > 0, `grandchild pid from stdout: ${JSON.stringify(r2.stdout)}`);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try {
      process.kill(gpid, 0);
      await new Promise((res) => setTimeout(res, 20));
    } catch {
      alive = false;
    }
  }
  if (alive) {
    try {
      process.kill(gpid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  assert.equal(alive, false, "the grandchild is gone after the group kill");

  const ok = runCtx([process.execPath, "-e", "console.log('hi')"], process.env, 5_000);
  assert.deepEqual(ok, { code: 0, stdout: "hi\n", stderr: "", error: undefined });
});

test("probe spawns ctx daemon status with CI removed, under the bound, and stamps the time; `ctx` pins the executable", () => {
  const calls = [];
  const run = (argv, env, timeoutMs) => {
    calls.push({ argv, env, timeoutMs });
    return good(HEALTHY);
  };
  const r = probe({ run, env: { CI: "true", PATH: "/usr/bin" }, now: () => NOW, timeoutMs: 1_234 });
  assert.equal(r.ok, true);
  assert.equal(r.at, NOW);
  assert.deepEqual(calls, [{ argv: [...STATUS_ARGV], env: { PATH: "/usr/bin" }, timeoutMs: 1_234 }]);
  probe({ run, env: { PATH: "/somewhere/else" }, now: () => NOW, ctx: "/Users/example/.local/bin/ctx" });
  assert.deepEqual(calls[1].argv, ["/Users/example/.local/bin/ctx", ...STATUS_ARGV.slice(1)], "the pinned path replaces the bare name; PATH does not matter");
});

test("heal runs ctx index mode auto only when mode is auto and the config file exists; `ctx` pins both spawns", () => {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(" "));
    return argv[2] === "mode" && argv[3] === "auto" ? good(HEALED) : good(MODE);
  };
  const r = heal({ run, env: { CI: "true" }, exists: (p) => p === "/Users/example/.ctx/config.toml" });
  assert.deepEqual(r, { attempted: true, ok: true, detail: '`ctx index mode auto --format json`: daemon running = true, supervisor "fallback"' });
  assert.deepEqual(calls, [MODE_ARGV.join(" "), HEAL_ARGV.join(" ")]);
  heal({ run, exists: () => true, ctx: "/opt/ctx" });
  assert.deepEqual(calls.slice(2), ["/opt/ctx index mode --format json", "/opt/ctx index mode auto --format json"]);
});

test("heal is not attempted on a manual mode, a missing config file, or a missing ctx", () => {
  const manual = heal({ run: () => good(MODE.replace('"auto"', '"manual"')), exists: () => true });
  assert.deepEqual(manual, { attempted: false, ok: false, detail: 'not attempted: ctx indexing mode is "manual", not auto; ctx-watch does not change it' });
  const noConfig = heal({ run: () => good(MODE), exists: () => false });
  assert.deepEqual(noConfig, { attempted: false, ok: false, detail: "not attempted: /Users/example/.ctx/config.toml does not exist (ctx is not set up here)" });
  const missing = heal({ run: () => ({ code: null, stdout: "", stderr: "", error: "ctx is not on PATH" }), exists: () => true });
  assert.deepEqual(missing, { attempted: false, ok: false, detail: "not attempted: ctx could not run: ctx is not on PATH" });
  const noJson = heal({ run: () => good("nope"), exists: () => true });
  assert.equal(noJson.attempted, false);
});

test("heal under CI (the suppressed capture) is attempted and reports ctx's line", () => {
  const run = (argv) => (argv[3] === "auto" ? { code: 1, stdout: "", stderr: HEAL_SUPPRESSED } : good(MODE));
  const r = heal({ run, exists: () => true });
  assert.equal(r.attempted, true);
  assert.equal(r.ok, false);
  assert.equal(r.detail, "`ctx index mode auto --format json` (exit 1): Error: ctx daemon start was suppressed (ci); retry after it clears or run `ctx setup --no-daemon`");
});

test("check: a passing probe is one spawn; a failing one heals and probes again", () => {
  const passing = [];
  const ok = check({ run: (argv) => (passing.push(argv.join(" ")), good(HEALTHY)), now: () => NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.healed, null);
  assert.equal(ok.timedOut, false);
  assert.deepEqual(passing, [STATUS_ARGV.join(" ")]);

  let status = 0;
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(" "));
    if (argv[1] === "daemon") return good(status++ === 0 ? NOT_RUNNING : HEALTHY);
    if (argv[3] === "auto") return good(HEALED);
    return good(MODE);
  };
  const r = check({ run, exists: () => true, now: () => NOW });
  assert.equal(r.ok, true, "the second probe passes after the heal");
  assert.equal(r.first.ok, false);
  assert.match(r.first.reason, /not running/);
  assert.equal(r.healed.attempted, true);
  assert.deepEqual(calls, [STATUS_ARGV.join(" "), MODE_ARGV.join(" "), HEAL_ARGV.join(" "), STATUS_ARGV.join(" ")]);
});

test("check: a heal that is not attempted leaves the first probe as the result, with the reason it was skipped", () => {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(" "));
    return argv[1] === "daemon" ? good(NOT_RUNNING) : good(MODE);
  };
  const r = check({ run, exists: () => false, now: () => NOW });
  assert.equal(r.ok, false);
  assert.equal(r.first, null);
  assert.match(r.healed.detail, /^not attempted/);
  assert.deepEqual(calls, [STATUS_ARGV.join(" "), MODE_ARGV.join(" ")]);
});

test("check with a deadline: the four spawns share one clock; each gets what is left; a step with nothing left is skipped and the line says it timed out", () => {
  // Each spawn is inside its own 1200 ms bound but takes 1000 ms; a 3000 ms deadline fits three.
  let clock = NOW;
  const now = () => clock;
  const calls = [];
  const run = (argv, _env, timeoutMs) => {
    calls.push({ argv: argv.join(" "), timeoutMs });
    clock += 1_000;
    if (argv[1] === "daemon") return good(NOT_RUNNING);
    if (argv[3] === "auto") return good(HEALED);
    return good(MODE);
  };
  const r = check({ run, exists: () => true, now, timeoutMs: 1_200, deadlineMs: 3_000 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.budgetExhausted, true);
  assert.deepEqual(calls.map((c) => c.argv), [STATUS_ARGV.join(" "), MODE_ARGV.join(" "), HEAL_ARGV.join(" ")], "no fourth spawn: nothing left on the clock");
  assert.deepEqual(calls.map((c) => c.timeoutMs), [1_200, 1_200, 1_000], "the third spawn gets what is left, not its own 1200");
  assert.equal(r.healed.attempted, true);
  assert.match(r.healed.detail, /; no time left to probe again$/);
  assert.match(r.reason, /^check timed out after 3000 ms \(the ctx daemon is not running \(/);
  assert.equal(r.fix, FIX);
  const line = needsYouLine(r);
  assert.match(line, /^ctx-watch: check timed out after 3000 ms \(/);
  assert.ok(line.length <= LINE_MAX);

  // A first probe that eats the whole clock: the heal is not attempted, and the line says so.
  clock = NOW;
  const slow = check({ run: (argv, _e, timeoutMs) => ((clock += timeoutMs), { code: null, stdout: "", stderr: "", error: `${argv.join(" ")} did not answer in ${timeoutMs / 1000} s` }), now, timeoutMs: 10_000, deadlineMs: 3_000 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.reason, "check timed out after 3000 ms (ctx could not run: ctx daemon status --format json did not answer in 3 s)");
  assert.equal(slow.healed.detail, "not attempted: the check's deadline passed");

  // A pass is a pass, however slow; and without a deadline nothing is cut.
  clock = NOW;
  const late = check({ run: () => ((clock += 5_000), good(HEALTHY)), now, timeoutMs: 1_200, deadlineMs: 3_000 });
  assert.equal(late.ok, true);
  assert.equal(late.timedOut, false);
  clock = NOW;
  const free = check({ run: (argv) => ((clock += 5_000), argv[1] === "daemon" ? good(NOT_RUNNING) : good(MODE)), exists: () => true, now, timeoutMs: 1_200 });
  assert.equal(free.timedOut, false);
  assert.match(free.reason, /^the ctx daemon is not running/);
});

test("check with an exhausted deadline never spawns: deadlineMs 0 skips the first probe and says the budget ran out; no spawn ever gets timeout 0", () => {
  const calls = [];
  const r = check({ run: (argv, _e, timeoutMs) => (calls.push(timeoutMs), good(HEALTHY)), exists: () => true, now: () => NOW, timeoutMs: 1_200, deadlineMs: 0 });
  assert.deepEqual(calls, [], "nothing was spawned");
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.budgetExhausted, true);
  assert.equal(r.first, null);
  assert.equal(r.healed, null);
  assert.equal(r.reason, "check timed out after 0 ms (no time left to probe ctx)");
  assert.ok(needsYouLine(r).length <= LINE_MAX);

  // The heal computes its budget once per spawn: the clock runs out between the mode read and
  // the heal, so the heal is skipped rather than spawned with 0 (the re-probe case is above).
  let clock = NOW;
  const seen = [];
  const run = (argv, _e, timeoutMs) => {
    seen.push({ argv: argv.join(" "), timeoutMs });
    clock += argv[3] === "auto" ? 1_000 : argv[1] === "index" ? 2_000 : 1_000;
    if (argv[1] === "daemon") return good(NOT_RUNNING);
    if (argv[3] === "auto") return good(HEALED);
    return good(MODE);
  };
  const cut = check({ run, exists: () => true, now: () => clock, timeoutMs: 5_000, deadlineMs: 3_000 });
  assert.deepEqual(seen.map((c) => c.argv), [STATUS_ARGV.join(" "), MODE_ARGV.join(" ")]);
  assert.ok(seen.every((c) => c.timeoutMs > 0), JSON.stringify(seen));
  assert.equal(cut.timedOut, true);
  assert.equal(cut.budgetExhausted, true);
  assert.equal(cut.healed.detail, "not attempted: the check's deadline passed");

  const ok = check({ run: () => good(HEALTHY), now: () => NOW, deadlineMs: 3_000 });
  assert.equal(ok.budgetExhausted, false);
});

test("runCtx with no time left does not spawn", () => {
  const missing = join(FIX_DIR, "definitely-not-a-ctx-watch-executable");
  for (const t of [0, -5]) {
    const r = runCtx([missing, "daemon", "status"], {}, t);
    assert.deepEqual(r, { code: null, stdout: "", stderr: "", error: `not run: no time left (timeout ${t} ms)` }, "an ENOENT here would mean it spawned");
  }
});

test("needsYouLine: null when ok; `ctx-watch: <reason>; fix: `<command>`` at most 160 characters", () => {
  assert.equal(needsYouLine({ ok: true }), null);
  const line = needsYouLine(judge(good(NOT_RUNNING), NOW));
  assert.equal(line, 'ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`');
  assert.ok(line.length <= LINE_MAX);
  const long = needsYouLine({ ok: false, reason: "x".repeat(400), fix: FIX });
  assert.equal(long.length, LINE_MAX);
  assert.ok(long.startsWith("ctx-watch: xxx"));
  assert.ok(long.endsWith("…; fix: `ctx index mode auto`"));
  for (const r of [judge(good(mutated((j) => (j.daemon.supervisor.status = "install_failed"))), NOW), judge(good(HEALTHY), NOW + STALE_MS * 2), judge({ code: null, stdout: "", stderr: "", error: "ctx is not on PATH" }, NOW)]) {
    const l = needsYouLine(r);
    assert.ok(l.length <= LINE_MAX, l);
    assert.match(l, /; fix: `[^`]+`$/);
  }
});
