// test/probe.test.mjs — judge(), probe(), heal(), check() and needsYouLine() against captured
// ctx 2.3.0 output (test/fixtures, captured 2026-11-04; see fixtures/README.md). The two
// derived cases (supervisor install_failed, stale core_refresh) change exactly one field of the
// healthy capture, named here, because ctx could not be made to print them without breaking a
// real installation; stale is also reachable by moving `now`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, probe, heal, check, needsYouLine, ctxEnv, age, STALE_MS, STATUS_ARGV, MODE_ARGV, HEAL_ARGV, FIX, FIX_MISSING, LINE_MAX } from "../lib/probe.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(join(FIX_DIR, name), "utf8");
const HEALTHY = fixture("ctx-daemon-status.txt");
const NOT_RUNNING = fixture("ctx-daemon-status-not-running.txt");
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
  assert.deepEqual(r.fields, { running: true, status: "running", pid: 1706, supervisor: "installed", lastRunAtMs: HEALTHY_LAST_RUN });
  assert.match(r.summary, /^daemon running \(pid 1706\), supervisor installed, core_refresh 1m ago$/);
});

test("running=false capture (a killed daemon, status stale_lock): fails naming .daemon.running and .daemon.status", () => {
  const r = judge(good(NOT_RUNNING), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock")');
  assert.equal(r.fix, FIX);
  assert.equal(r.fields.supervisor, "fallback");
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

test("ctx missing: the spawn error is the reason and the fix is the install doc", () => {
  const r = judge({ code: null, stdout: "", stderr: "", error: "ctx is not on PATH" }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ctx could not run: ctx is not on PATH");
  assert.equal(r.fix, FIX_MISSING);
  assert.match(CTX_MISSING, /No such file or directory/, "the unavailable capture is the shell's ctx-missing line");
  const slow = judge({ code: null, stdout: "", stderr: "", error: "ctx daemon status --format json did not answer in 10 s" }, NOW);
  assert.equal(slow.reason, "ctx could not run: ctx daemon status --format json did not answer in 10 s");
  assert.equal(slow.fix, FIX);
});

test("probe spawns ctx daemon status with CI removed, under the bound, and stamps the time", () => {
  const calls = [];
  const run = (argv, env, timeoutMs) => {
    calls.push({ argv, env, timeoutMs });
    return good(HEALTHY);
  };
  const r = probe({ run, env: { CI: "true", PATH: "/usr/bin" }, now: () => NOW, timeoutMs: 1_234 });
  assert.equal(r.ok, true);
  assert.equal(r.at, NOW);
  assert.deepEqual(calls, [{ argv: [...STATUS_ARGV], env: { PATH: "/usr/bin" }, timeoutMs: 1_234 }]);
});

test("heal runs ctx index mode auto only when mode is auto and the config file exists", () => {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(" "));
    return argv[2] === "mode" && argv[3] === "auto" ? good(HEALED) : good(MODE);
  };
  const r = heal({ run, env: { CI: "true" }, exists: (p) => p === "/Users/example/.ctx/config.toml" });
  assert.deepEqual(r, { attempted: true, ok: true, detail: '`ctx index mode auto --format json`: daemon running = true, supervisor "fallback"' });
  assert.deepEqual(calls, [MODE_ARGV.join(" "), HEAL_ARGV.join(" ")]);
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
