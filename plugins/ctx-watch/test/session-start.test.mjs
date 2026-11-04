// test/session-start.test.mjs — the SessionStart output contract: healthy and on time → null
// (nothing printed); a failing probe → { systemMessage: "ctx-watch: <reason>; fix: `<cmd>`" }
// (≤ 160 chars); a check that runs out of its 3 s clock → `ctx-watch: check timed out after
// 3000 ms (…)`, inside the runner's 4 s; a timer that has not ticked in 2× its interval → the
// dead-man's line (the install command with its path shell-quoted and not cut); the first run
// stamps firstSeenAt. handle() is driven in-process with the probe injected, then the hook is
// spawned as Claude Code spawns it, with a fake `ctx` on PATH printing a fixture (or hanging),
// and its stdout read back as JSON.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handle, timerLine, HOOK_SPAWN_MS, HOOK_DEADLINE_MS } from "../hooks/session-start.mjs";
import { readState, writeState, statePath, EMPTY } from "../lib/state.mjs";
import { LINE_MAX } from "../lib/probe.mjs";
import { DEADLINE_MS } from "../lib/hook-runner.mjs";
import { CLI_PATH } from "../scripts/ctx-watch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "session-start.mjs");
const FIX_DIR = join(ROOT, "test", "fixtures");
const HEALTHY = readFileSync(join(FIX_DIR, "ctx-daemon-status.txt"), "utf8");
const NOT_RUNNING = readFileSync(join(FIX_DIR, "ctx-daemon-status-not-running.txt"), "utf8");
const MODE = readFileSync(join(FIX_DIR, "ctx-index-mode.txt"), "utf8");
const NOW = JSON.parse(HEALTHY).daemon.jobs.core_refresh.last_run_at_ms + 60_000;
const good = (stdout) => ({ code: 0, stdout, stderr: "" });
const input = { session_id: "s-test", cwd: "/Users/example/repo", hook_event_name: "SessionStart", source: "startup" };

function box() {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-hook-"));
  const env = { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), PATH: "/usr/bin:/bin" };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}
const runWith = (status) => (argv) => (argv[1] === "daemon" ? good(status) : good(MODE));

test("healthy and no timer stamp yet: null, and firstSeenAt is stamped once", () => {
  const b = box();
  try {
    assert.equal(handle(input, { env: b.env, now: () => NOW, run: runWith(HEALTHY) }), null);
    const s = readState(statePath(b.env));
    assert.equal(s.firstSeenAt, NOW);
    assert.equal(handle(input, { env: b.env, now: () => NOW + 1, run: runWith(HEALTHY) }), null);
    assert.equal(readState(statePath(b.env)).firstSeenAt, NOW, "stamped once");
  } finally {
    b.release();
  }
});

test("a failing probe is one systemMessage line, ≤ 160 chars, with the reason and the fix", () => {
  const b = box();
  try {
    const out = handle(input, { env: b.env, now: () => NOW, run: runWith(NOT_RUNNING), exists: () => false });
    assert.deepEqual(out, { systemMessage: 'ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`' });
    assert.ok(out.systemMessage.length <= LINE_MAX);
    assert.equal(out.systemMessage.split("\n").length, 1);
  } finally {
    b.release();
  }
});

test("the probe spawns with the hook's shorter bound and CI removed", () => {
  const b = box();
  try {
    const seen = [];
    handle(input, { env: { ...b.env, CI: "true" }, now: () => NOW, run: (argv, env, timeoutMs) => (seen.push({ env, timeoutMs }), good(HEALTHY)) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].timeoutMs, HOOK_SPAWN_MS);
    assert.equal(HOOK_SPAWN_MS, 1_200);
    assert.equal("CI" in seen[0].env, false);
  } finally {
    b.release();
  }
});

test("four spawns each inside their own bound but over the shared 3 s clock: the fourth is skipped and the line says the check timed out, under 160 chars, with the stamp still written", () => {
  const b = box();
  try {
    assert.equal(HOOK_DEADLINE_MS, 3_000);
    assert.ok(HOOK_DEADLINE_MS + 1_000 <= DEADLINE_MS, "the check's clock plus a second for the stamp fits the runner's deadline");
    let clock = NOW;
    const calls = [];
    const run = (argv, _env, timeoutMs) => {
      calls.push({ argv: argv.join(" "), timeoutMs });
      clock += 1_000;
      return argv[1] === "daemon" ? good(NOT_RUNNING) : argv[3] === "auto" ? good(NOT_RUNNING) : good(MODE);
    };
    const out = handle(input, { env: b.env, now: () => clock, run, exists: () => true });
    assert.equal(calls.length, 3, "status, mode, mode auto; no second status");
    assert.deepEqual(calls.map((c) => c.timeoutMs), [1_200, 1_200, 1_000]);
    const lines = out.systemMessage.split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ctx-watch: check timed out after 3000 ms \(the ctx daemon is not running .*; fix: `ctx index mode auto`$/);
    assert.ok(lines[0].length <= LINE_MAX, lines[0]);
    assert.equal(readState(statePath(b.env)).firstSeenAt, clock, "the state write still happens after the check");
  } finally {
    b.release();
  }
});

test("dead-man's line: the tick has not run in more than 2× the interval; none when it has; the path is quoted and never cut", () => {
  const b = box();
  try {
    const file = statePath(b.env);
    writeState(file, { ...EMPTY, lastTickAt: NOW - 601_000, intervalS: 300 });
    const out = handle(input, { env: b.env, now: () => NOW, run: runWith(HEALTHY), cliPath: "/Users/example/plugins/ctx-watch/scripts/ctx-watch.mjs" });
    assert.deepEqual(out, { systemMessage: `ctx-watch: timer has not run since ${new Date(NOW - 601_000).toISOString()}; run \`node /Users/example/plugins/ctx-watch/scripts/ctx-watch.mjs install\` and the printed launchctl line` });
    assert.equal(timerLine(0).startsWith("ctx-watch: timer has not run since 1970-01-01T00:00:00.000Z; run `node "), true);
    assert.match(timerLine(0), new RegExp(`node ${CLI_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} install`), "the default names this checkout's script");
    const long = "/Users/example/.claude/plugins/cache/jo-wolff-plugins/ctx-watch/0.1.0/scripts/ctx-watch.mjs";
    const installed = timerLine(0, long);
    assert.ok(installed.length > LINE_MAX, "an installed plugin's path takes the line past 160 characters");
    assert.ok(installed.includes(`run \`node ${long} install\``), "and the command is whole: a cut path is not a command");
    assert.equal(timerLine(0, "/Users/example/My Plugins/ctx-watch.mjs"), "ctx-watch: timer has not run since 1970-01-01T00:00:00.000Z; run `node '/Users/example/My Plugins/ctx-watch.mjs' install` and the printed launchctl line");

    writeState(file, { ...EMPTY, lastTickAt: NOW - 599_000, intervalS: 300 });
    assert.equal(handle(input, { env: b.env, now: () => NOW, run: runWith(HEALTHY) }), null);

    writeState(file, { ...EMPTY, firstSeenAt: NOW - 700_000 });
    const never = handle(input, { env: b.env, now: () => NOW, run: runWith(HEALTHY) });
    assert.match(never.systemMessage, /^ctx-watch: timer has not run since /, "never ticked: overdue from the first SessionStart stamp at the default 300 s");
  } finally {
    b.release();
  }
});

test("both lines when the daemon is down and the timer is overdue, probe first", () => {
  const b = box();
  try {
    writeState(statePath(b.env), { ...EMPTY, lastTickAt: NOW - 3_600_000, intervalS: 300 });
    const out = handle(input, { env: b.env, now: () => NOW, run: runWith(NOT_RUNNING), exists: () => false, cliPath: "/Users/example/cli.mjs" });
    const lines = out.systemMessage.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^ctx-watch: the ctx daemon is not running/);
    assert.match(lines[1], /^ctx-watch: timer has not run since /);
    assert.ok(lines[0].length <= LINE_MAX, lines[0]);
  } finally {
    b.release();
  }
});

test("a state file with a field out of shape is one errors.log line, and the hook treats it as never ticked", () => {
  const b = box();
  try {
    const file = statePath(b.env);
    writeState(file, { ...EMPTY, lastTickAt: "yesterday", intervalS: 300 });
    const out = handle(input, { env: b.env, now: () => NOW, run: runWith(HEALTHY) });
    assert.equal(out, null, "never ticked and no firstSeenAt: nothing to say yet");
    const log = readFileSync(join(b.env.XDG_STATE_HOME, "ctx-watch", "errors.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    assert.match(log[0], /^\d{4}-.*Z state\.json .*state\.json ignored: lastTickAt is "yesterday", not epoch ms \| null; treated as absent$/);
    assert.equal(readState(file).firstSeenAt, NOW, "the stamp replaced the bad file");
  } finally {
    b.release();
  }
});

test("an unwritable state directory: the probe line still comes, plus a stamp line and one errors.log line", () => {
  const b = box();
  try {
    const dir = join(b.env.XDG_STATE_HOME, "ctx-watch");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "errors.log"), "");
    chmodSync(dir, 0o555);
    try {
      const out = handle(input, { env: b.env, now: () => NOW, run: runWith(NOT_RUNNING), exists: () => false });
      const lines = out.systemMessage.split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^ctx-watch: the ctx daemon is not running/);
      assert.match(lines[1], new RegExp(`^ctx-watch: state not written to ${statePath(b.env)}: `));
      assert.ok(lines[1].length <= LINE_MAX);
      const log = readFileSync(join(dir, "errors.log"), "utf8").trim().split("\n");
      assert.equal(log.length, 1);
      assert.match(log[0], /^\d{4}-.*Z SessionStart state not written to /);
      const healthy = handle(input, { env: b.env, now: () => NOW, run: runWith(HEALTHY) });
      assert.match(healthy.systemMessage, /^ctx-watch: state not written to /, "a healthy daemon still gets the stamp line: the dead-man's switch is off without it");
    } finally {
      chmodSync(dir, 0o755);
    }
  } finally {
    b.release();
  }
});

/**
 * A fake `ctx` on PATH printing `status` for `daemon status`, the mode fixture for `index mode`,
 * refusing the heal. `hangS` makes `daemon status` and `index mode auto` sleep that long first
 * (`index mode` stays quick, naming a config file that exists, so the heal is attempted).
 */
function fakeCtxBin(dir, status, { hangS = 0 } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "status.json"), status);
  writeFileSync(join(bin, "config.toml"), "");
  writeFileSync(join(bin, "mode.json"), hangS ? MODE.replace(/"config_path": "[^"]*"/, `"config_path": ${JSON.stringify(join(bin, "config.toml"))}`) : MODE);
  const hang = hangS ? `sleep ${hangS}; ` : "";
  writeFileSync(join(bin, "ctx"), `#!/bin/sh\ncase "$1 $2" in\n  "daemon status") ${hang}cat "${join(bin, "status.json")}";;\n  "index mode") if [ "$3" = "auto" ]; then ${hang}echo "Error: fake ctx does not heal" >&2; exit 1; fi; cat "${join(bin, "mode.json")}";;\n  *) exit 2;;\nesac\n`);
  chmodSync(join(bin, "ctx"), 0o755);
  return bin;
}

function spawnHook(env, stdin) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env, timeout: 6_000, killSignal: "SIGKILL" });
  return { ...r, ms: Date.now() - started };
}

test("spawned: a failing fixture on PATH → stdout is the systemMessage JSON, exit 0; a healthy one → no stdout", () => {
  const b = box();
  try {
    const bad = fakeCtxBin(join(b.root, "bad"), NOT_RUNNING);
    const r = spawnHook({ ...b.env, PATH: `${bad}:/usr/bin:/bin`, CI: "true" }, JSON.stringify(input));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < 5_000);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, { systemMessage: 'ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`' });
    assert.equal(readFileSync(join(b.env.XDG_STATE_HOME, "ctx-watch", "errors.log"), { encoding: "utf8", flag: "a+" }), "", "a failing daemon is not a hook fault");

    const fresh = JSON.parse(HEALTHY);
    fresh.daemon.jobs.core_refresh.last_run_at_ms = Date.now();
    const ok = fakeCtxBin(join(b.root, "ok"), JSON.stringify(fresh));
    const r2 = spawnHook({ ...b.env, PATH: `${ok}:/usr/bin:/bin`, CI: "true" }, JSON.stringify(input));
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout, "", "healthy: nothing printed");
    assert.equal(typeof readState(statePath(b.env)).firstSeenAt, "number");
  } finally {
    b.release();
  }
});

test("spawned: a ctx that hangs on status and heal → the hook's own timed-out line inside the runner's 4 s, exit 0, no errors.log line (not the runner's fail-open)", () => {
  const b = box();
  try {
    // status hangs (1.2 s), mode is quick, mode auto hangs (1.2 s), the second status gets the ~0.6 s left and hangs: the clock is spent.
    const slow = fakeCtxBin(join(b.root, "slow"), NOT_RUNNING, { hangS: 30 });
    const r = spawnHook({ ...b.env, PATH: `${slow}:/usr/bin:/bin`, CI: "true" }, JSON.stringify(input));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.ms < DEADLINE_MS, `answered in ${r.ms} ms, inside the runner's ${DEADLINE_MS}`);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /^ctx-watch: check timed out after 3000 ms \(ctx could not run: ctx daemon status --format json did not answer in 0\.\d+ s\); fix: `ctx index mode auto`$/);
    assert.ok(out.systemMessage.length <= LINE_MAX);
    assert.equal(readFileSync(join(b.env.XDG_STATE_HOME, "ctx-watch", "errors.log"), { encoding: "utf8", flag: "a+" }), "", "a slow ctx is the line, not a hook fault");
    assert.equal(typeof readState(statePath(b.env)).firstSeenAt, "number", "and the stamp still landed");
  } finally {
    b.release();
  }
});

test("spawned: no ctx on PATH → the line says ctx could not run and points at the install doc; exit 0", () => {
  const b = box();
  try {
    const r = spawnHook({ ...b.env, PATH: join(b.root, "nothing-here") }, JSON.stringify(input));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: "ctx-watch: ctx could not run: ctx is not on PATH; fix: `ctx docs show getting-started`" });
  } finally {
    b.release();
  }
});
