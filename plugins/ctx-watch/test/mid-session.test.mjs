// test/mid-session.test.mjs — the mid-session hook (0.4.0, hooks/mid-session.mjs on
// UserPromptSubmit and on a failed ctx call's PostToolUseFailure). It reads only the timer's
// state.json and a per-session latch, never ctx or launchctl, and tells the agent once per
// session per episode: once when ctx goes down (or its upgrade is stuck, or its upgrade state is
// unknown), once (one line) when it comes back, once when the state itself is stale. Healthy, a
// one-tick blip, or only the semantic index not ready: nothing. handle() is driven in-process
// against a temp XDG_STATE_HOME; the hook is then spawned as Claude Code spawns it, with a `ctx`
// and a `launchctl` on PATH that leave a mark if anything runs them, and timed. Every module is
// imported as a namespace so a checkout without the hook fails each test on its own assertion.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as hook from "../hooks/mid-session.mjs";
import * as session from "../hooks/session-start.mjs";
import * as retention from "../lib/retention.mjs";
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
    put(b);
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
    put(b);
    assert.ok(context(ask(b, prompt(), NOW + MIN)));
    put(b, down({ downSince: NOW + 20 * MIN, lastProbe: { at: NOW + 20 * MIN, ok: false, reason: "ctx could not run: timed out", healed: null } }));
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
    put(b);
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
    assert.ok(median(healthy) < hook.TEST_BUDGET_MS, `healthy median ${median(healthy).toFixed(1)} ms over ${hook.TEST_BUDGET_MS} ms: ${healthy.map((x) => x.toFixed(0)).join(", ")}`);
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
