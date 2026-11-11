// test/slow.test.mjs — a ctx that answers slowly while its daemon process is alive (a loaded
// machine: 2026-11-11 22:44Z-23:06Z, load average 78-183, two false "ctx is down" popups) is
// slow, not down: no strike, no popup, no "down" told to the agent; a timeout with no live daemon
// is a failure as before, and slow past SLOW_MAX_MS counts as down (a live but hung daemon).
// Fakes and temp directories only: the real ~/.ctx is never read and its socket never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { probe, check, daemonAlive, connectSocket, FIX } from "../lib/probe.mjs";
import { EMPTY, step, statePath, writeState, readState, STRIKES_TO_DOWN, SLOW_MAX_MS } from "../lib/state.mjs";
import * as lib from "../lib/mid-session.mjs";
import * as hook from "../hooks/mid-session.mjs";
import { handle } from "../hooks/session-start.mjs";
import { main } from "../scripts/ctx-watch.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HEALTHY = readFileSync(join(FIX_DIR, "ctx-daemon-status.txt"), "utf8");
const NOT_RUNNING = readFileSync(join(FIX_DIR, "ctx-daemon-status-not-running.txt"), "utf8");
const NOW = JSON.parse(HEALTHY).daemon.jobs.core_refresh.last_run_at_ms + 60_000;
const MIN = 60_000;
const ENV = { CTX_DATA_ROOT: join(FIX_DIR, "no-ctx-data-root"), PATH: "/usr/bin:/bin" };
const TIMED_OUT = { code: null, stdout: "", stderr: "", error: "ctx daemon status --format json did not answer in 10 s", timedOut: true };
const good = (stdout) => ({ code: 0, stdout, stderr: "" });
const LIVE = () => ({ alive: true, pid: 51357, detail: "the ctx daemon's query socket accepted a connection (pid 51357)" });
const DEAD = () => ({ alive: false, pid: 51357, detail: "pid 51357 is not running" });

/** A run double: every ctx call times out, and the calls are counted. */
function timingOut() {
  const calls = [];
  return { calls, run: (argv) => (calls.push(argv.slice(1).join(" ")), TIMED_OUT) };
}

const deadPid = () => {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
};

// --- the probe and the check -------------------------------------------------------------

test("slow: a status timeout while the daemon is alive is slow, not a failure to heal: no upgrade read, no heal", () => {
  const t = timingOut();
  const r = check({ env: ENV, now: () => NOW, run: t.run, exists: () => true, daemonAlive: LIVE });
  assert.equal(r.ok, false);
  assert.equal(r.slow, true);
  assert.match(r.reason, /did not answer in 10 s/);
  assert.match(r.reason, /daemon is running/);
  assert.match(r.reason, /slow, not down/);
  assert.deepEqual(t.calls, ["daemon status --format json"], "nothing but the one status call: no `ctx upgrade status`, no heal");
  assert.equal(r.healed.attempted, false);
});

test("slow: a status timeout with no live daemon stays a failure, as before (the upgrade gate is read)", () => {
  const t = timingOut();
  const r = check({ env: ENV, now: () => NOW, run: t.run, exists: () => true, daemonAlive: DEAD });
  assert.equal(r.ok, false);
  assert.notEqual(r.slow, true);
  assert.match(r.reason, /ctx could not run: .*did not answer in 10 s/);
  assert.ok(t.calls.includes("upgrade status --format json"), t.calls.join(", "));
});

test("slow: only a timeout asks whether the daemon is alive; a daemon that says it is not running fails with no liveness check", () => {
  let asked = 0;
  const r = probe({ env: ENV, now: () => NOW, run: () => good(NOT_RUNNING), daemonAlive: () => (asked++, LIVE()) });
  assert.equal(r.ok, false);
  assert.notEqual(r.slow, true);
  assert.equal(asked, 0);
});

// --- the episode -------------------------------------------------------------------------

const slowResult = (at) => ({ ...check({ env: ENV, now: () => at, run: timingOut().run, daemonAlive: LIVE }) });
const deadResult = (at) => check({ env: ENV, now: () => at, run: () => good(NOT_RUNNING), daemonAlive: DEAD, heal: false });
const passResult = (at) => check({ env: ENV, now: () => at, run: () => good(HEALTHY), daemonAlive: LIVE });

test("slow: slow ticks hold the episode: no strike, no popup, slowSince kept from the first; a pass clears it", () => {
  let s = { ...EMPTY };
  for (let i = 0; i < 4; i++) {
    const at = NOW + i * 5 * MIN;
    const r = step(s, slowResult(at), at);
    assert.equal(r.popup, false, `tick ${i}`);
    assert.equal(r.state.episode, "up", `tick ${i}`);
    assert.equal(r.state.strikes, 0, `tick ${i}`);
    assert.equal(r.state.slowSince, NOW, `tick ${i}`);
    assert.equal(r.state.lastTickAt, at);
    s = r.state;
  }
  const after = step(s, passResult(NOW + 20 * MIN), NOW + 20 * MIN).state;
  assert.equal(after.slowSince, null);
});

test("slow: a run of slow ticks followed by a real death goes down on the second failing tick, with its popup", () => {
  let s = { ...EMPTY };
  for (let i = 0; i < 3; i++) s = step(s, slowResult(NOW + i * 5 * MIN), NOW + i * 5 * MIN).state;
  const first = step(s, deadResult(NOW + 15 * MIN), NOW + 15 * MIN);
  assert.equal(first.state.episode, "strike");
  assert.equal(first.state.slowSince, null, "a real failure ends the slow run");
  const second = step(first.state, deadResult(NOW + 20 * MIN), NOW + 20 * MIN);
  assert.equal(second.state.episode, "down");
  assert.equal(second.popup, true);
});

test("slow: slow for longer than SLOW_MAX_MS counts as down (a live daemon hung for good): strike, then down with the popup", () => {
  assert.equal(SLOW_MAX_MS, 30 * MIN);
  let s = { ...EMPTY };
  let last = null;
  let at = NOW;
  for (; at - NOW < SLOW_MAX_MS; at += 5 * MIN) {
    last = step(s, slowResult(at), at);
    assert.equal(last.state.episode, "up", `${(at - NOW) / MIN} min`);
    s = last.state;
  }
  const strike = step(s, slowResult(at), at);
  assert.equal(strike.state.episode, "strike", "the first slow tick past the bound strikes");
  const down = step(strike.state, slowResult(at + 5 * MIN), at + 5 * MIN);
  assert.equal(down.state.episode, "down");
  assert.equal(down.state.episodeKind, "daemon");
  assert.equal(down.popup, true);
});

test("slow: a state.json from before slowSince reads as not slow", () => {
  const dir = mkdtempSync(join("/tmp", "cw-state-"));
  try {
    const file = join(dir, "state.json");
    const { slowSince, ...old } = { ...EMPTY, slowSince: null };
    writeFileSync(file, JSON.stringify(old));
    assert.equal(readState(file, { log: () => {} }).slowSince, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the tick ----------------------------------------------------------------------------

test("slow: the tick's line is `slow: …`, the episode stays up and no popup is started", async () => {
  const dir = mkdtempSync(join("/tmp", "cw-tick-"));
  try {
    const env = { ...ENV, HOME: dir, XDG_STATE_HOME: join(dir, "state") };
    let popups = 0;
    const deps = { env, now: () => NOW, run: timingOut().run, exists: () => true, popup: () => (popups++, { ok: true }), daemonAlive: LIVE };
    const a = await main(["tick"], deps);
    const b = await main(["tick"], { ...deps, now: () => NOW + 5 * MIN });
    for (const r of [a, b]) assert.match(r.text, / slow: ctx could not run: .*slow, not down.* \| episode up, strikes 0/);
    assert.equal(popups, 0);
    assert.equal(readState(statePath(env)).slowSince, NOW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the agent ---------------------------------------------------------------------------

function sessionBox() {
  const root = mkdtempSync(join("/tmp", "cw-sess-"));
  const env = { ...ENV, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state") };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}
const prompt = { session_id: "s-slow", hook_event_name: "UserPromptSubmit", prompt: "hi" };
const say = (b, at) => hook.handle(prompt, { env: b.env, now: () => at });
const slowState = (since, at) => ({ ...EMPTY, lastTickAt: at, intervalS: 300, slowSince: since, lastProbe: { at, ok: false, reason: "ctx could not run: ctx daemon status --format json did not answer in 10 s; the ctx daemon is running: slow, not down", healed: null } });

test("slow: the mid-session hook never says down for a slow run; after 15 min of it, one quiet line, once", () => {
  const b = sessionBox();
  try {
    writeState(statePath(b.env), slowState(NOW, NOW + 10 * MIN));
    assert.equal(say(b, NOW + 10 * MIN + 1000), null, "10 min slow: nothing");
    writeState(statePath(b.env), slowState(NOW, NOW + 15 * MIN));
    const out = say(b, NOW + 15 * MIN + 1000);
    const text = out?.hookSpecificOutput?.additionalContext ?? "";
    assert.match(text, /answering slowly/);
    assert.match(text, /may time out/);
    assert.doesNotMatch(text, /down|repair/i);
    assert.equal(text.split("\n").length, 1);
    writeState(statePath(b.env), slowState(NOW, NOW + 20 * MIN));
    assert.equal(say(b, NOW + 20 * MIN + 1000), null, "said once per slow run");
    writeState(statePath(b.env), { ...slowState(null, NOW + 25 * MIN), lastProbe: { at: NOW + 25 * MIN, ok: true, reason: null, healed: null } });
    assert.equal(say(b, NOW + 25 * MIN + 1000), null, "the end of a slow run is not news");
  } finally {
    b.release();
  }
});

test("slow: SessionStart tells neither the person nor the agent that ctx is down when it is slow, and latches nothing", () => {
  const b = sessionBox();
  try {
    writeState(statePath(b.env), { ...EMPTY, lastTickAt: NOW, intervalS: 300 });
    const out = handle({ session_id: "s-slow", hook_event_name: "SessionStart", source: "startup" }, { env: b.env, now: () => NOW + 1000, run: timingOut().run, exists: () => true, daemonAlive: LIVE });
    assert.equal(out, null, JSON.stringify(out));
    assert.deepEqual(lib.readLatch(lib.latchPath(join(b.env.XDG_STATE_HOME, "ctx-watch"), "s-slow")), { down: null, toldAt: null, stale: null, slow: null });
  } finally {
    b.release();
  }
});

// --- the liveness check itself (a real unix socket in a temp directory) ---------------------

function endpoint(pid, sockPath) {
  const root = mkdtempSync(join("/tmp", "cw-ep-"));
  mkdirSync(join(root, "daemon"));
  writeFileSync(join(root, "daemon", "query-endpoint.json"), JSON.stringify({ path: sockPath ?? join(root, "daemon", "query.sock"), pid, schema_version: 1, token: "t", transport: "unix" }));
  return { root, sock: sockPath ?? join(root, "daemon", "query.sock"), release: () => rmSync(root, { recursive: true, force: true }) };
}

test("slow: daemonAlive is true when the endpoint's pid runs and its socket accepts a connection; it never calls ctx", async () => {
  const ep = endpoint(process.pid);
  const server = createServer((c) => c.destroy());
  await new Promise((resolve) => server.listen(ep.sock, resolve));
  try {
    const t0 = performance.now();
    const r = daemonAlive({ env: { CTX_DATA_ROOT: ep.root, PATH: "/nonexistent" } });
    assert.equal(r.alive, true, r.detail);
    assert.equal(r.pid, process.pid);
    assert.ok(performance.now() - t0 < 2_000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    ep.release();
  }
});

test("slow: daemonAlive is false for a dead pid (no connect tried), a missing or broken endpoint, and a reused pid whose socket no one listens on", () => {
  let connects = 0;
  const connect = () => (connects++, { ok: true, detail: "connected" });
  const dead = endpoint(deadPid());
  try {
    const r = daemonAlive({ env: { CTX_DATA_ROOT: dead.root }, connect });
    assert.equal(r.alive, false);
    assert.match(r.detail, /not running/);
    assert.equal(connects, 0);
  } finally {
    dead.release();
  }
  assert.equal(daemonAlive({ env: { CTX_DATA_ROOT: join(FIX_DIR, "no-ctx-data-root") } }).alive, false);
  const broken = endpoint(process.pid);
  try {
    writeFileSync(join(broken.root, "daemon", "query-endpoint.json"), "{not json");
    assert.equal(daemonAlive({ env: { CTX_DATA_ROOT: broken.root } }).alive, false);
  } finally {
    broken.release();
  }
  // The pid names a live process (this one), but it is not a ctx daemon: nothing listens on the socket.
  const reused = endpoint(process.pid);
  try {
    writeFileSync(reused.sock, "");
    const r = daemonAlive({ env: { CTX_DATA_ROOT: reused.root } });
    assert.equal(r.alive, false, r.detail);
    assert.match(r.detail, /did not accept/);
  } finally {
    reused.release();
  }
});

test("slow: FIX is unchanged for a slow run that outlasted the bound (the popup's fix line)", () => {
  const r = slowResult(NOW);
  assert.equal(r.fix, FIX);
  assert.ok(STRIKES_TO_DOWN >= 2);
});

// --- Codex round 4 on PR #112 ---------------------------------------------------------------

/** A semantic-down state, a session SessionStart told of a daemon outage (no timer downSince yet), then one tick of `result`. */
function toldThenTick(b, result, at) {
  const s0 = { ...EMPTY, episode: "down", episodeKind: "semantic", strikes: 2, kindStrikes: 2, downSince: NOW - 2 * MIN, lastTickAt: NOW - 1000, intervalS: 300, lastProbe: { at: NOW - 1000, ok: false, reason: "the ctx semantic index is not ready", healed: null } };
  writeState(statePath(b.env), s0);
  const dir = join(b.env.XDG_STATE_HOME, "ctx-watch");
  assert.equal(lib.noteTold(dir, "s-slow", { toldAt: NOW }), null);
  writeState(statePath(b.env), step(s0, result, at).state);
  return dir;
}

test("r4: a slow tick after a semantic episode is no recovery: nothing said, the outage latch kept", () => {
  const b = sessionBox();
  try {
    const dir = toldThenTick(b, slowResult(NOW + 1000), NOW + 1000);
    assert.equal(readState(statePath(b.env)).episodeKind, "semantic", "the slow tick holds the old kind (the precondition)");
    assert.equal(say(b, NOW + 2000), null, "a status call that timed out answered nothing");
    assert.equal(lib.readLatch(lib.latchPath(dir, "s-slow")).toldAt, NOW, "the outage latch survives");
  } finally {
    b.release();
  }
});

test("r4: a live-upgrade tick after a semantic episode is no recovery either", () => {
  const b = sessionBox();
  try {
    const waiting = { ok: false, upgrading: true, at: NOW + 1000, reason: "upgrade in progress", fix: "ctx upgrade status --format json", fields: {}, healed: null };
    const dir = toldThenTick(b, waiting, NOW + 1000);
    assert.equal(say(b, NOW + 2000), null);
    assert.equal(lib.readLatch(lib.latchPath(dir, "s-slow")).toldAt, NOW);
  } finally {
    b.release();
  }
});

test("r4: a tick that answered semantic-only after the telling is still the daemon's recovery", () => {
  const b = sessionBox();
  try {
    const semantic = { ok: false, healable: false, at: NOW + 1000, reason: "the ctx semantic index is not ready", fix: "ctx semantic enable --wait", fields: {}, healed: null };
    const dir = toldThenTick(b, semantic, NOW + 1000);
    const text = say(b, NOW + 2000)?.hookSpecificOutput?.additionalContext ?? "";
    assert.match(text, /daemon is back/);
    assert.equal(lib.readLatch(lib.latchPath(dir, "s-slow")).toldAt, null);
  } finally {
    b.release();
  }
});

test("r4: endpoint paths that are not ctx's socket shapes are not alive, and never reach the connector", () => {
  let connects = 0;
  const connect = () => (connects++, { ok: true, detail: "connected" });
  const ep = endpoint(process.pid);
  const file = join(ep.root, "daemon", "query-endpoint.json");
  const put = (o) => writeFileSync(file, JSON.stringify({ schema_version: 1, transport: "unix", pid: process.pid, token: "t", ...o }));
  try {
    for (const path of ["--version", "--help", "-e", "bad\0socket", "query.sock", "daemon/query.sock", "/etc/passwd", join(ep.root, "elsewhere.sock"), `/tmp/ctx-q-${"a".repeat(32)}/../x.sock`, "/".repeat(2048), 42, null, ""]) {
      put({ path });
      const r = daemonAlive({ env: { CTX_DATA_ROOT: ep.root }, connect });
      assert.equal(r.alive, false, `path ${JSON.stringify(path)}`);
      assert.match(r.detail, /not ctx's query socket|no pid and socket path/, `path ${JSON.stringify(path)}: ${r.detail}`);
    }
    put({ path: ep.sock, transport: "tcp" });
    assert.equal(daemonAlive({ env: { CTX_DATA_ROOT: ep.root }, connect }).alive, false, "a transport other than unix");
    assert.equal(connects, 0, "the connector is never handed a path of the wrong shape");
    // The two shapes ctx 2.3.0 binds: <data root>/daemon/query.sock, or /tmp-or-TMPDIR/ctx-q-<32 hex>/q.sock when that is too long.
    put({ path: ep.sock });
    assert.equal(daemonAlive({ env: { CTX_DATA_ROOT: ep.root }, connect }).alive, true);
    put({ path: `/tmp/ctx-q-${"0123456789abcdef".repeat(2)}/q.sock` });
    assert.equal(daemonAlive({ env: { CTX_DATA_ROOT: ep.root }, connect }).alive, true);
  } finally {
    ep.release();
  }
});

test("r4: a connector that throws, and the default connector handed option-like text, are not alive and never throw", () => {
  const ep = endpoint(process.pid);
  try {
    const r = daemonAlive({ env: { CTX_DATA_ROOT: ep.root }, connect: () => { throw new TypeError("boom"); } });
    assert.equal(r.alive, false);
    assert.match(r.detail, /boom/);
    for (const path of ["--version", "--help", "bad\0socket"]) {
      const c = connectSocket(path, 2_000);
      assert.equal(c.ok, false, `connectSocket(${JSON.stringify(path)}): ${c.detail}`);
    }
  } finally {
    ep.release();
  }
});

test("r4: check() with a garbled endpoint and a timed-out status call is an ordinary failure, not slow, and does not throw", () => {
  const ep = endpoint(process.pid);
  try {
    for (const path of ["--version", "bad\0socket"]) {
      writeFileSync(join(ep.root, "daemon", "query-endpoint.json"), JSON.stringify({ schema_version: 1, transport: "unix", pid: process.pid, path }));
      const r = check({ env: { ...ENV, CTX_DATA_ROOT: ep.root }, now: () => NOW, run: timingOut().run, exists: () => true });
      assert.equal(r.ok, false);
      assert.notEqual(r.slow, true, JSON.stringify(path));
    }
  } finally {
    ep.release();
  }
});
