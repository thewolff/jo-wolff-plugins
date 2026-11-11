// test/mid-session.test.mjs — the mid-session hook (0.4.0, hooks/mid-session.mjs on
// UserPromptSubmit and on a failed ctx call's PostToolUseFailure). It reads only the timer's
// state.json and a per-session latch, never ctx or launchctl, and tells the agent once per
// session per episode: once when ctx goes down (or its upgrade is stuck, or its upgrade state is
// unknown), once (one line) when it comes back, once when the state itself is stale. Healthy, a
// one-tick blip, or only the semantic index not ready: nothing. handle() is driven in-process
// against a temp XDG_STATE_HOME; the hook is then spawned as Claude Code spawns it, with a `ctx`
// and a `launchctl` on PATH that leave a mark if anything runs them, and timed. On a checkout
// without hooks/mid-session.mjs (0.3.0) the import fails and the whole file fails as one test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as hook from "../hooks/mid-session.mjs";
import * as session from "../hooks/session-start.mjs";
import * as retention from "../lib/retention.mjs";
import * as lib from "../lib/mid-session.mjs";
import { EMPTY, statePath, stateDir, writeState } from "../lib/state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "mid-session.mjs");
const HOOKS_JSON = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
const NOT_RUNNING = readFileSync(join(ROOT, "test", "fixtures", "ctx-daemon-status-not-running.txt"), "utf8");
const MODE = readFileSync(join(ROOT, "test", "fixtures", "ctx-index-mode.txt"), "utf8");
const MIN = 60_000;
const NOW = 1_794_400_000_000; // 2026-11-11T…, a fixed clock
const DOWN_AT = NOW - 40 * MIN;
const prompt = (session_id = "s-1") => ({ session_id, cwd: "/Users/example/repo", hook_event_name: "UserPromptSubmit", prompt: "carry on" });
const failure = (session_id = "s-1", command = "ctx search 'the thread'") => ({ session_id, cwd: "/Users/example/repo", hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error: "Exit code 1\nError: ctx daemon is not running", is_interrupt: false });

function box() {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-mid-"));
  const env = { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), PATH: "/usr/bin:/bin" };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}

/** The state a tick leaves: `up` and fresh by default. */
function put(b, fields = {}) {
  assert.equal(writeState(statePath(b.env), { ...EMPTY, lastTickAt: NOW - MIN, intervalS: 300, lastProbe: { at: NOW - MIN, ok: true, reason: null, healed: null }, ...fields }), true);
}
const down = (fields = {}) => ({
  episode: "down",
  strikes: 9,
  episodeKind: "daemon",
  kindStrikes: 9,
  downSince: DOWN_AT,
  lastProbe: { at: NOW - MIN, ok: false, reason: 'the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock")', healed: "not attempted" },
  ...fields,
});
const ask = (b, input = prompt(), at = NOW) => hook.handle(input, { env: b.env, now: () => at, cliPath: "/opt/ctx watch/scripts/ctx-watch.mjs" });
/** A fresh tick at `t` whose probe passed: affirmative evidence of recovery from `t` on. */
const passedAt = (t) => ({ lastTickAt: t, lastProbe: { at: t, ok: true, reason: null, healed: null } });
const latchOf = (b, id = "s-1") => lib.readLatch(hook.latchPath(stateDir(b.env), id));
const context = (out) => out?.hookSpecificOutput?.additionalContext ?? null;

test("mid-session: healthy and fresh is silent, and nothing is written", () => {
  const b = box();
  try {
    put(b);
    assert.equal(ask(b), null);
    assert.equal(ask(b, failure()), null);
    assert.equal(existsSync(join(stateDir(b.env), "sessions")), false, "no latch for a session that was told nothing");
  } finally {
    b.release();
  }
});

test("mid-session: a down episode is told once per session: what, since when, and /ctx-watch:repair; then silent", () => {
  const b = box();
  try {
    put(b, down());
    const first = ask(b);
    assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const text = context(first);
    assert.match(text, /ctx daemon/);
    assert.match(text, /stale_lock/);
    assert.ok(text.includes(new Date(DOWN_AT).toISOString()), text);
    assert.match(text, /\/ctx-watch:repair/);
    assert.match(text, /node '\/opt\/ctx watch\/scripts\/ctx-watch\.mjs' repair/);
    assert.ok(text.length < 900, `short: ${text.length} chars`);
    assert.equal(first.systemMessage, undefined, "the agent's context only: the person has the popup and the SessionStart line");
    assert.equal(ask(b, prompt(), NOW + MIN), null, "latched");
    assert.equal(ask(b, prompt(), NOW + 2 * MIN), null, "still latched");
    assert.match(context(ask(b, prompt("s-2"))) ?? "", /ctx daemon/, "another session is told on its own");
  } finally {
    b.release();
  }
});

test("mid-session: recovery is one line, once, and only to a session that was told it was down", () => {
  const b = box();
  try {
    put(b, down());
    assert.ok(context(ask(b)));
    put(b, passedAt(NOW + 4 * MIN));
    const back = context(ask(b, prompt(), NOW + 5 * MIN));
    assert.ok(back, "told it is back");
    assert.equal(back.split("\n").length, 1, back);
    assert.match(back, /back/);
    assert.equal(ask(b, prompt(), NOW + 6 * MIN), null, "once");
    assert.equal(ask(b, prompt("never-told")), null, "a session never told it was down hears nothing on recovery");
  } finally {
    b.release();
  }
});

test("mid-session: a second outage in the same session is a new episode and is told again", () => {
  const b = box();
  try {
    put(b, down());
    assert.ok(context(ask(b)));
    put(b, passedAt(NOW + MIN / 2));
    assert.ok(context(ask(b, prompt(), NOW + MIN)));
    put(b, down({ downSince: NOW + 20 * MIN, lastTickAt: NOW + 20 * MIN, lastProbe: { at: NOW + 20 * MIN, ok: false, reason: "ctx could not run: timed out", healed: null } }));
    const again = context(ask(b, prompt(), NOW + 21 * MIN));
    assert.match(again ?? "", /ctx could not run: timed out/);
  } finally {
    b.release();
  }
});

test("mid-session: a stuck upgrade and an unknown upgrade state are told; a one-tick strike and a semantic-only episode are not", () => {
  const b = box();
  try {
    put(b, down({ episodeKind: "upgrade", lastProbe: { at: NOW - MIN, ok: false, reason: 'ctx upgrade stuck in "quiescing" for 6d (owner pid 4242 dead): no ctx daemon can start', healed: null } }));
    const stuck = context(ask(b, prompt("s-stuck")));
    assert.match(stuck ?? "", /upgrade/);
    assert.match(stuck, /quiescing/);
    assert.match(stuck, /\/ctx-watch:repair/);
    put(b, down({ lastProbe: { at: NOW - MIN, ok: false, reason: 'the ctx daemon is not running (.daemon.running = false, .daemon.status = "stopped"); not healed: upgrade state unknown', healed: null } }));
    assert.match(context(ask(b, prompt("s-unknown"))) ?? "", /upgrade state unknown/);
    put(b, { episode: "strike", strikes: 1, episodeKind: "daemon", kindStrikes: 1, lastProbe: { at: NOW - MIN, ok: false, reason: "blip", healed: null } });
    assert.equal(ask(b, prompt("s-strike")), null, "one failing tick is a blip");
    put(b, down({ episodeKind: "semantic", lastProbe: { at: NOW - MIN, ok: false, reason: "the ctx semantic index is not ready", healed: null } }));
    assert.equal(ask(b, prompt("s-semantic")), null, "the daemon is up; ctx search answers lexically");
  } finally {
    b.release();
  }
});

test("mid-session: a state the timer stopped stamping over 15 min ago is one line, once, whatever it says", () => {
  const b = box();
  try {
    put(b, { lastTickAt: NOW - 20 * MIN, lastProbe: { at: NOW - 20 * MIN, ok: true, reason: null, healed: null } });
    const stale = context(ask(b));
    assert.ok(stale, "a stale healthy state is not trusted");
    assert.equal(stale.split("\n").length, 1, stale);
    assert.ok(stale.includes(new Date(NOW - 20 * MIN).toISOString()), stale);
    assert.equal(ask(b, prompt(), NOW + MIN), null, "once");
    put(b, { lastTickAt: NOW - 10 * MIN });
    assert.equal(ask(b, prompt("s-fresh")), null, "10 min is within the bound");
    put(b, down({ lastTickAt: NOW - 30 * MIN }));
    const staleDown = context(ask(b, prompt("s-stale-down")));
    assert.equal(staleDown.split("\n").length, 1, "stale wins: the down it last saw is not current news");
    assert.match(staleDown, /stale_lock|down|fail/);
  } finally {
    b.release();
  }
});

test("mid-session: no session id, or no state at all, is silent", () => {
  const b = box();
  try {
    put(b, down());
    assert.equal(ask(b, { hook_event_name: "UserPromptSubmit", prompt: "x" }), null);
    assert.equal(ask(b, { ...prompt(), session_id: "  " }), null);
    const b2 = box();
    try {
      assert.equal(ask(b2), null, "never ticked and never seen: nothing is known");
    } finally {
      b2.release();
    }
  } finally {
    b.release();
  }
});

test("mid-session: a failed ctx call answers as PostToolUseFailure and shares the prompt hook's latch", () => {
  const b = box();
  try {
    put(b, down());
    const out = ask(b, failure());
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.match(context(out), /\/ctx-watch:repair/);
    assert.equal(ask(b, prompt()), null, "the next prompt in that session is not told again");
    assert.equal(ask(b, failure()), null);
  } finally {
    b.release();
  }
});

test("mid-session: hooks.json registers it on UserPromptSubmit, and on failed ctx Bash calls and ctx MCP tools", () => {
  const cmds = (event) => (HOOKS_JSON.hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => ({ matcher: g.matcher ?? null, if: h.if ?? null, command: h.command })));
  const ups = cmds("UserPromptSubmit");
  assert.equal(ups.length, 1);
  assert.match(ups[0].command, /hooks\/mid-session\.mjs" UserPromptSubmit$/);
  const fails = cmds("PostToolUseFailure");
  assert.ok(fails.some((h) => h.matcher === "Bash" && h.if === "Bash(ctx *)" && /mid-session\.mjs" PostToolUseFailure$/.test(h.command)), JSON.stringify(fails));
  assert.ok(fails.some((h) => h.matcher === "mcp__ctx__.*" && /mid-session\.mjs" PostToolUseFailure$/.test(h.command)), JSON.stringify(fails));
});

test("mid-session: SessionStart that told the agent about a down episode latches it, so the first prompt is silent and recovery is still told", () => {
  const b = box();
  try {
    put(b, down({ lastTickAt: NOW - MIN }));
    const run = (argv) => ({ code: 0, stdout: argv[1] === "daemon" ? NOT_RUNNING : argv[1] === "upgrade" ? JSON.stringify({ state: { status: "dry_run" }, auto_upgrade: { enabled: false } }) : MODE, stderr: "" });
    const start = session.handle({ session_id: "s-1", hook_event_name: "SessionStart", source: "startup" }, { env: b.env, now: () => NOW, run, exists: () => false });
    assert.ok(start.hookSpecificOutput?.additionalContext, "SessionStart told the agent");
    assert.equal(ask(b), null, "not told twice");
    put(b, passedAt(NOW + 4 * MIN));
    assert.match(context(ask(b, prompt(), NOW + 5 * MIN)) ?? "", /back/);
  } finally {
    b.release();
  }
});

test("mid-session: prune removes session latches past --days and keeps fresh ones", () => {
  const b = box();
  try {
    put(b, down());
    assert.ok(context(ask(b, prompt("old"))));
    assert.ok(context(ask(b, prompt("new"))));
    const dir = stateDir(b.env);
    const old = hook.latchPath(dir, "old");
    const t = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, t, t);
    const r = retention.prune(dir, { days: 30 });
    assert.ok(r.removedPaths.includes(old), JSON.stringify(r));
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(hook.latchPath(dir, "new")), true);
  } finally {
    b.release();
  }
});

/** PATH with a `ctx` and a `launchctl` that leave a mark if run, then the system's. */
function trapPath(b) {
  const bin = join(b.root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["ctx", "launchctl"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${join(b.root, "ran")}'\nexit 1\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
}
const spawnHook = (b, env, input, event = "UserPromptSubmit") => {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK, event], { env, input: JSON.stringify(input), encoding: "utf8", timeout: 5_000 });
  return { ...r, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};
const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
/** The spawned hook's bound here: the target is well under 100 ms idle (measured by hand), loosened so a parallel `node --test` does not flake. */
const SPAWN_BUDGET_MS = 250;

test("mid-session: spawned, it runs no ctx and no launchctl, answers once, and a healthy prompt costs one node start", () => {
  const b = box();
  try {
    const env = { ...b.env, PATH: trapPath(b) };
    put(b, { lastTickAt: Date.now() - MIN, lastProbe: { at: Date.now() - MIN, ok: true, reason: null, healed: null } });
    const healthy = [];
    for (let i = 0; i < 7; i++) {
      const r = spawnHook(b, env, prompt());
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "", "healthy: nothing printed");
      healthy.push(r.ms);
    }
    put(b, down({ downSince: Date.now() - 40 * MIN, lastTickAt: Date.now() - MIN }));
    const told = spawnHook(b, env, prompt());
    assert.equal(told.status, 0, told.stderr);
    assert.match(JSON.parse(told.stdout).hookSpecificOutput.additionalContext, /\/ctx-watch:repair/);
    const quiet = spawnHook(b, env, prompt());
    assert.equal(quiet.stdout, "", "latched across processes");
    const viaFailure = spawnHook(b, env, failure("s-9"), "PostToolUseFailure");
    assert.equal(JSON.parse(viaFailure.stdout).hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.equal(existsSync(join(b.root, "ran")), false, `ran: ${existsSync(join(b.root, "ran")) ? readFileSync(join(b.root, "ran"), "utf8") : ""}`);
    // The budget is "well under 100 ms" on an idle machine (measured in the report); under a
    // parallel `node --test` the bound here is looser so the suite does not flake.
    assert.ok(median(healthy) < SPAWN_BUDGET_MS, `healthy median ${median(healthy).toFixed(1)} ms over ${SPAWN_BUDGET_MS} ms: ${healthy.map((x) => x.toFixed(0)).join(", ")}`);
  } finally {
    b.release();
  }
});

test("mid-session: handle() itself (state read, latch) stays in single-digit milliseconds", () => {
  const b = box();
  try {
    put(b);
    const times = [];
    for (let i = 0; i < 50; i++) {
      const t = process.hrtime.bigint();
      ask(b);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    assert.ok(median(times) < 10, `median ${median(times).toFixed(2)} ms`);
  } finally {
    b.release();
  }
});

// --- Codex round 1 on PR #112 ---

test("mid-session: a state that vanishes, is not JSON, is out of shape, is unreadable, or was reset is no recovery, and the outage latch survives until a real pass", () => {
  const b = box();
  try {
    const file = statePath(b.env);
    const breakers = {
      missing: () => rmSync(file, { force: true }),
      "not JSON": () => writeFileSync(file, "{bad"),
      "out of shape": () => writeFileSync(file, JSON.stringify({ episode: "bogus" })),
      unreadable: () => chmodSync(file, 0o000),
      "reset to up with no probe": () => put(b, { lastTickAt: NOW + MIN, lastProbe: null }),
      "a pass older than the telling": () => put(b, passedAt(NOW - 2 * MIN)),
      "a failing strike since": () => put(b, { lastTickAt: NOW + MIN, episode: "strike", strikes: 1, episodeKind: "daemon", kindStrikes: 1, lastProbe: { at: NOW + MIN, ok: false, reason: "still down", healed: null } }),
    };
    for (const [name, breakIt] of Object.entries(breakers)) {
      put(b, down());
      rmSync(join(stateDir(b.env), "sessions"), { recursive: true, force: true });
      assert.match(context(ask(b)) ?? "", /ctx daemon/, `${name}: told first`);
      breakIt();
      assert.equal(ask(b, prompt(), NOW + 2 * MIN), null, `${name}: no recovery claimed`);
      assert.notEqual(latchOf(b).toldAt, null, `${name}: the outage latch is intact`);
      if (existsSync(file)) chmodSync(file, 0o644);
    }
    put(b, passedAt(NOW + 3 * MIN));
    assert.match(context(ask(b, prompt(), NOW + 4 * MIN)) ?? "", /back/, "a fresh pass after the telling is the recovery");
    assert.equal(latchOf(b).toldAt, null);
  } finally {
    b.release();
  }
});

test("mid-session: a semantic-only failure after a daemon outage is the daemon's recovery, said as such", () => {
  const b = box();
  try {
    put(b, down());
    assert.ok(context(ask(b)));
    put(b, { lastTickAt: NOW + MIN, episode: "strike", strikes: 1, episodeKind: "semantic", kindStrikes: 1, lastProbe: { at: NOW + MIN, ok: false, reason: "the ctx semantic index is not ready", healed: null } });
    const back = context(ask(b, prompt(), NOW + 2 * MIN));
    assert.match(back ?? "", /daemon is back/);
    assert.match(back, /semantic index is not ready/);
  } finally {
    b.release();
  }
});

test("mid-session: a session latch another process holds is that process's notice: this one says nothing and writes nothing", () => {
  const b = box();
  try {
    put(b, down());
    const sessions = join(stateDir(b.env), "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s-1.json.lock"), `${process.pid} held-by-a-peer\n`);
    assert.equal(ask(b), null);
    assert.equal(existsSync(hook.latchPath(stateDir(b.env), "s-1")), false);
  } finally {
    b.release();
  }
});

/** Two hook processes reading the same missing latch at the same moment (Codex's barrier): each pauses right after its latch read until `release` exists. */
const RACER = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [dir, tag, event] = process.argv.slice(1);
const original = fs.readFileSync;
fs.readFileSync = (path, ...rest) => {
  if (String(path).endsWith("/sessions/race.json")) {
    let value, error;
    try { value = original(path, ...rest); } catch (e) { error = e; }
    fs.writeFileSync(dir + "/" + tag + ".ready", "");
    while (!fs.existsSync(dir + "/release")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    if (error) throw error;
    return value;
  }
  return original(path, ...rest);
};
syncBuiltinESMExports();
const { midSession } = await import("./lib/mid-session.mjs");
const input = event === "PostToolUseFailure"
  ? { session_id: "race", hook_event_name: event, tool_name: "Bash", tool_input: { command: "ctx search x" } }
  : { session_id: "race", hook_event_name: event };
console.log(JSON.stringify(midSession(input, { env: { HOME: dir, XDG_STATE_HOME: dir } })));
`;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test("mid-session: two hooks claiming the same session's notice at once say it once (prompt and failed ctx call)", async () => {
  const b = box();
  try {
    const dir = b.env.XDG_STATE_HOME;
    mkdirSync(dir, { recursive: true });
    put(b, down({ lastTickAt: Date.now() - MIN, downSince: Date.now() - 20 * MIN }));
    const kids = [["a", "UserPromptSubmit"], ["b", "PostToolUseFailure"]].map(([tag, event]) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", RACER, dir, tag, event], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      return new Promise((resolve) => child.on("close", (code) => resolve({ code, out: out.trim(), err })));
    });
    const until = Date.now() + 10_000;
    while (!existsSync(join(dir, "a.ready")) && !existsSync(join(dir, "b.ready"))) {
      assert.ok(Date.now() < until, "neither racer reached its latch read");
      await sleepMs(5);
    }
    await sleepMs(400); // the other racer reads now, or waits on the claim
    writeFileSync(join(dir, "release"), "");
    const results = await Promise.all(kids);
    for (const r of results) assert.equal(r.code, 0, r.err);
    const told = results.filter((r) => /ctx-watch:repair/.test(r.out));
    assert.equal(told.length, 1, results.map((r) => r.out).join("\n"));
  } finally {
    b.release();
  }
});

const sessionRun = (daemon) => (argv) => ({ code: 0, stdout: argv[1] === "daemon" ? daemon : argv[1] === "upgrade" ? JSON.stringify({ state: { status: "dry_run" }, auto_upgrade: { enabled: false } }) : MODE, stderr: "" });
const startSession = (b, at, daemon = NOT_RUNNING) => session.handle({ session_id: "s-1", hook_event_name: "SessionStart", source: "startup" }, { env: b.env, now: () => at, run: sessionRun(daemon), exists: () => false });

test("mid-session: SessionStart telling of an outage the timer has not declared yet is latched: no repeat when the timer declares it, one recovery after", () => {
  const b = box();
  try {
    put(b, passedAt(NOW - MIN)); // the timer last saw ctx up, a minute before the session
    const start = startSession(b, NOW);
    assert.match(start.hookSpecificOutput?.additionalContext ?? "", /daemon is not running/);
    assert.notEqual(latchOf(b).toldAt, null, "SessionStart's notice is latched though the timer's episode is up");
    assert.equal(ask(b, prompt(), NOW + MIN), null, "the timer's older pass is not a recovery");
    put(b, { lastTickAt: NOW + 2 * MIN, episode: "strike", strikes: 1, episodeKind: "daemon", kindStrikes: 1, lastProbe: { at: NOW + 2 * MIN, ok: false, reason: "not running", healed: null } });
    assert.equal(ask(b, prompt(), NOW + 3 * MIN), null, "the strike is the same outage");
    put(b, down({ downSince: NOW + 7 * MIN, lastTickAt: NOW + 7 * MIN, lastProbe: { at: NOW + 7 * MIN, ok: false, reason: "not running", healed: null } }));
    assert.equal(ask(b, prompt(), NOW + 8 * MIN), null, "the timer declaring it down is not news to this session");
    put(b, passedAt(NOW + 12 * MIN));
    assert.match(context(ask(b, prompt(), NOW + 13 * MIN)) ?? "", /back/);
    assert.equal(ask(b, prompt(), NOW + 14 * MIN), null, "once");
  } finally {
    b.release();
  }
});

test("mid-session: SessionStart telling of an outage, then the next tick passing, is one recovery", () => {
  const b = box();
  try {
    put(b, passedAt(NOW - MIN));
    assert.ok(startSession(b, NOW).hookSpecificOutput?.additionalContext);
    put(b, passedAt(NOW + 4 * MIN));
    assert.match(context(ask(b, prompt(), NOW + 5 * MIN)) ?? "", /back/);
  } finally {
    b.release();
  }
});

test("mid-session: SessionStart's live-upgrade context is not an outage notice and is not latched", () => {
  const b = box();
  try {
    put(b, passedAt(NOW - MIN));
    const run = (argv) => ({ code: 0, stdout: argv[1] === "daemon" ? NOT_RUNNING : argv[1] === "upgrade" ? JSON.stringify({ state: { status: "applying", last_attempt_at: new Date(NOW - MIN).toISOString() }, auto_upgrade: { enabled: true } }) : MODE, stderr: "" });
    const start = session.handle({ session_id: "s-1", hook_event_name: "SessionStart", source: "startup" }, { env: b.env, now: () => NOW, run, exists: () => false });
    assert.match(start.hookSpecificOutput?.additionalContext ?? "", /upgrade is in progress/);
    assert.equal(existsSync(hook.latchPath(stateDir(b.env), "s-1")), false);
  } finally {
    b.release();
  }
});
