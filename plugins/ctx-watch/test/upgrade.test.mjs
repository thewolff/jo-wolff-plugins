// test/upgrade.test.mjs — the 0.3.0 behaviours, from the 2026-11-05 → 11-11 outage (ctx 2.3.0's
// automatic upgrade to 2.4.1 died between `quiescing` and `applying` twice and left a state that
// fenced out every new daemon; ctx-watch healed into the handoff, popped once, and went quiet):
//
//   1. a live upgrade is not healed: `ctx upgrade status` in an active state and/or a fresh
//      handoff marker whose owner is alive → no `ctx index mode auto`, the tick reports it and
//      does not strike;
//   2. a stuck upgrade (active state over 30 min, handoff owner dead or the marker stale) is its
//      own finding kind with its own popup latch, naming the release sequence; ctx-watch runs
//      none of it;
//   3. the heal runs only from the timer and the CLI, with a bound above ctx's own 75 s
//      quiescence wait, and is stopped with SIGTERM and a grace before SIGKILL; SessionStart
//      never heals;
//   4. `install` carries LANG (and ctx's other launch-environment names) into the plist;
//   5. a popup that gave up unread re-arms after POPUP_REARM_MS, not every tick;
//   6. SessionStart tells the agent (hookSpecificOutput.additionalContext) when ctx is down,
//      upgrading or stuck, and says nothing when healthy.
//
// Every module is imported as a namespace so that, against a checkout without these exports,
// each test fails on its own assertion instead of the whole file failing to load. ctx,
// launchctl, plutil and osascript are doubles; the handoff marker lives under a temp
// CTX_DATA_ROOT, never ~/.ctx.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as probe from "../lib/probe.mjs";
import * as stateLib from "../lib/state.mjs";
import * as launchd from "../lib/launchd.mjs";
import * as popupLib from "../lib/popup.mjs";
import * as hook from "../hooks/session-start.mjs";
import { main } from "../scripts/ctx-watch.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NOT_RUNNING = readFileSync(join(FIX_DIR, "ctx-daemon-status-not-running.txt"), "utf8");
const HEALTHY = readFileSync(join(FIX_DIR, "ctx-daemon-status.txt"), "utf8");
const MODE = readFileSync(join(FIX_DIR, "ctx-index-mode.txt"), "utf8");
/** `ctx upgrade status --format json`, 2026-11-11 (state `dry_run`: the shape after the release). */
const UPGRADE = JSON.parse(readFileSync(join(FIX_DIR, "ctx-upgrade-status.txt"), "utf8"));
const good = (stdout) => ({ code: 0, stdout, stderr: "" });
const MIN = 60_000;

/** The upgrade fixture with `.state.status` and `.state.last_attempt_at` changed (derived: no `quiescing` capture exists that did not break a real install). */
const upgradeAt = (status, attemptAtMs) => JSON.stringify({ ...UPGRADE, state: { ...UPGRADE.state, status, last_attempt_at: new Date(attemptAtMs).toISOString() } });

/** A pid that is not running: a child that has already exited. */
const deadPid = () => spawnSync("/bin/sh", ["-c", "exit 0"]).pid;

function box() {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-upgrade-"));
  const env = { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), CTX_DATA_ROOT: join(root, "ctx"), PATH: "/usr/bin:/bin" };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write <CTX_DATA_ROOT>/daemon/upgrade-handoff.json as ctx 2.3.0 does; `ageMs` backdates its mtime. */
function writeHandoff(env, { pid, phase = "ready", ageMs = 0 }) {
  const file = join(env.CTX_DATA_ROOT, "daemon", "upgrade-handoff.json");
  mkdirSync(dirname(file), { recursive: true });
  const at = Date.now() - ageMs;
  writeFileSync(file, JSON.stringify({ handoff_id: "ua_test", owner_pid: pid, phase, schema_version: 1, updated_at_ms: at }));
  utimesSync(file, at / 1000, at / 1000);
  return file;
}

/** A ctx double recording every call (argv after the executable, the bound, the options). */
function ctxDouble({ status = NOT_RUNNING, upgrade = JSON.stringify(UPGRADE) } = {}) {
  const calls = [];
  const run = (argv, env, timeoutMs, opts) => {
    calls.push({ cmd: argv.slice(1).join(" "), timeoutMs, opts });
    if (argv[1] === "daemon") return good(status);
    if (argv[1] === "upgrade") return typeof upgrade === "string" ? good(upgrade) : upgrade;
    if (argv[3] === "auto") return good(NOT_RUNNING);
    return good(MODE);
  };
  return { calls, run, cmds: () => calls.map((c) => c.cmd) };
}

const STATE_CHANGING = /^(index mode auto|upgrade (disable|enable|--dry-run)|upgrade$|setup)/;

// ---------------------------------------------------------------------------------------------
// 1. Do not fight a live upgrade.

test("1. upgrade in progress: `quiescing` with a live handoff owner skips the heal and says so", () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: process.pid });
    const d = ctxDouble({ upgrade: upgradeAt("quiescing", Date.now() - 2 * MIN) });
    const r = probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    assert.equal(r.ok, false);
    assert.equal(r.upgrading, true, "the result is marked as an upgrade in progress");
    assert.match(r.reason, /upgrade in progress/);
    assert.match(r.reason, /"quiescing"/);
    assert.match(r.reason, new RegExp(`pid ${process.pid}`));
    assert.equal(r.healed.attempted, false);
    assert.deepEqual(d.cmds().filter((c) => STATE_CHANGING.test(c)), [], "no state-changing ctx command ran");
  } finally {
    b.release();
  }
});

test("1. upgrade in progress: a fresh live handoff owner skips the heal even when `ctx upgrade status` cannot answer (the daemon reads running = false mid-handoff)", () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: process.pid });
    const d = ctxDouble({ upgrade: { code: null, stdout: "", stderr: "", error: "ctx upgrade status --format json did not answer in 10 s" } });
    const r = probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    assert.equal(r.upgrading, true);
    assert.deepEqual(d.cmds().filter((c) => STATE_CHANGING.test(c)), []);
  } finally {
    b.release();
  }
});

test("1. no upgrade: a `dry_run` state and no handoff marker still heal as before", () => {
  const b = box();
  try {
    const d = ctxDouble();
    const r = probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    assert.notEqual(r.upgrading, true);
    assert.ok(d.cmds().includes("index mode auto --format json"), "the heal ran");
  } finally {
    b.release();
  }
});

test("1. tick during a live upgrade: no strike, no popup, the line says `wait` and names the upgrade", async () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: process.pid });
    const d = ctxDouble({ upgrade: upgradeAt("applying", Date.now() - MIN) });
    let popups = 0;
    const popup = async () => (popups++, { started: true, detail: "popup shown (test)" });
    for (let i = 0; i < 3; i++) {
      const r = await main(["tick"], { env: b.env, run: d.run, exists: () => true, popup });
      assert.match(r.text, /wait: .*upgrade in progress/);
    }
    const s = stateLib.readState(stateLib.statePath(b.env));
    assert.deepEqual({ episode: s.episode, strikes: s.strikes, popups }, { episode: "up", strikes: 0, popups: 0 });
    assert.deepEqual(d.cmds().filter((c) => STATE_CHANGING.test(c)), []);
  } finally {
    b.release();
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Detect a stuck upgrade.

test("2. stuck: `quiescing` for over 30 min with a dead handoff owner is an `upgrade` finding naming the release sequence; nothing is run", () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: deadPid(), ageMs: 40 * MIN });
    const d = ctxDouble({ upgrade: upgradeAt("quiescing", Date.now() - 2 * 60 * MIN) });
    const r = probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    assert.equal(r.ok, false);
    assert.equal(r.kind, "upgrade");
    assert.notEqual(r.upgrading, true);
    assert.match(r.reason, /stuck/);
    assert.match(r.reason, /"quiescing"/);
    assert.equal(r.fix, "ctx upgrade disable && ctx upgrade --dry-run && ctx index mode auto");
    assert.equal(stateLib.failureKind(r), "upgrade");
    assert.deepEqual(d.cmds().filter((c) => STATE_CHANGING.test(c)), [], "ctx-watch runs none of the release sequence itself");
    assert.match(probe.needsYouLine(r), /fix: `ctx upgrade disable && ctx upgrade --dry-run && ctx index mode auto`$/);
  } finally {
    b.release();
  }
});

test("2. stuck: with automatic upgrades already off, the sequence starts at the release", () => {
  const b = box();
  try {
    const off = JSON.parse(upgradeAt("quiescing", Date.now() - 2 * 60 * MIN));
    off.auto_upgrade = { enabled: false, mode: "off" };
    const d = ctxDouble({ upgrade: JSON.stringify(off) });
    const r = probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    assert.equal(r.kind, "upgrade");
    assert.equal(r.fix, "ctx upgrade --dry-run && ctx index mode auto");
  } finally {
    b.release();
  }
});

test("2. not yet stuck: `quiescing` under 30 min with a dead owner waits (no heal, no finding)", () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: deadPid() });
    const d = ctxDouble({ upgrade: upgradeAt("quiescing", Date.now() - 10 * MIN) });
    const r = probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    assert.equal(r.upgrading, true);
    assert.notEqual(r.kind, "upgrade");
    assert.deepEqual(d.cmds().filter((c) => STATE_CHANGING.test(c)), []);
  } finally {
    b.release();
  }
});

test("2. a live owner past 30 min whose marker ctx itself calls stale (over 15 min) is stuck: ctx's own rule, not pid liveness alone", () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: process.pid, ageMs: 20 * MIN });
    const d = ctxDouble({ upgrade: upgradeAt("quiescing", Date.now() - 45 * MIN) });
    const r = probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    assert.equal(r.kind, "upgrade");
  } finally {
    b.release();
  }
});

test("2. readHandoff mirrors ctx 2.3.0's handoff_marker_state_at: absent, terminal phases, stale mtime, dead owner, live owner, unknown phase", () => {
  const b = box();
  try {
    const file = join(b.env.CTX_DATA_ROOT, "daemon", "upgrade-handoff.json");
    assert.equal(probe.handoffPath(b.env), file);
    assert.equal(probe.readHandoff(file, { now: Date.now() }).state, "absent");
    writeHandoff(b.env, { pid: process.pid });
    assert.equal(probe.readHandoff(file, { now: Date.now() }).state, "active");
    writeHandoff(b.env, { pid: process.pid, phase: "completed" });
    assert.equal(probe.readHandoff(file, { now: Date.now() }).state, "terminal");
    writeHandoff(b.env, { pid: process.pid, ageMs: 16 * MIN });
    assert.equal(probe.readHandoff(file, { now: Date.now() }).state, "terminal", "over DAEMON_UPGRADE_HANDOFF_STALE_AFTER (15 min)");
    writeHandoff(b.env, { pid: deadPid() });
    assert.equal(probe.readHandoff(file, { now: Date.now() }).state, "terminal");
    writeHandoff(b.env, { pid: process.pid, phase: "mystery" });
    assert.equal(probe.readHandoff(file, { now: Date.now() }).state, "corrupt");
    assert.equal(probe.HANDOFF_STALE_MS, 15 * MIN);
    assert.equal(probe.UPGRADE_STUCK_MS, 30 * MIN);
  } finally {
    b.release();
  }
});

test("2. tick: two stuck ticks pop the `upgrade` popup, with its own latch, even after the daemon's popup was delivered", async () => {
  const b = box();
  try {
    const file = stateLib.statePath(b.env);
    stateLib.writeState(file, { ...stateLib.EMPTY, episode: "down", strikes: 9, episodeKind: "daemon", kindStrikes: 9, popupShown: { daemon: true, semantic: false }, downSince: 1, lastPopupAt: 1 });
    writeHandoff(b.env, { pid: deadPid(), ageMs: 40 * MIN });
    const d = ctxDouble({ upgrade: upgradeAt("quiescing", Date.now() - 2 * 60 * MIN) });
    const texts = [];
    const popup = async ({ text }) => (texts.push(text), { started: true, seen: true, detail: "popup shown (test)" });
    await main(["tick"], { env: b.env, run: d.run, exists: () => true, popup });
    await main(["tick"], { env: b.env, run: d.run, exists: () => true, popup });
    assert.equal(texts.length, 1);
    assert.match(texts[0], /ctx upgrade --dry-run/);
    assert.match(texts[0], /observed, not documented/);
    const s = stateLib.readState(file);
    assert.equal(s.episodeKind, "upgrade");
    assert.equal(s.popupShown.upgrade, true);
  } finally {
    b.release();
  }
});

// ---------------------------------------------------------------------------------------------
// 3. Heal timeouts.

test("3. the heal's bound covers ctx's own 75 s installation quiescence wait plus its 5 s stop and 5 s restart, with a SIGTERM grace", () => {
  const b = box();
  try {
    const d = ctxDouble();
    probe.check({ env: b.env, run: d.run, exists: () => true, now: Date.now });
    const healCall = d.calls.find((c) => c.cmd === "index mode auto --format json");
    assert.ok(healCall, "the heal ran");
    assert.ok(probe.HEAL_TIMEOUT_MS >= 75_000 + 5_000 + 5_000, `HEAL_TIMEOUT_MS ${probe.HEAL_TIMEOUT_MS}`);
    assert.equal(healCall.timeoutMs, probe.HEAL_TIMEOUT_MS);
    assert.ok(healCall.opts?.graceMs > 0, "the heal is stopped with SIGTERM and a grace, not SIGKILL at once");
    const status = d.calls.find((c) => c.cmd === "daemon status --format json");
    assert.equal(status.timeoutMs, probe.PROBE_TIMEOUT_MS, "read-only status calls keep the short bound");
  } finally {
    b.release();
  }
});

test("3. SessionStart never heals: a down daemon is probed (and the upgrade read) but `ctx index mode auto` is not run", () => {
  const b = box();
  try {
    const d = ctxDouble();
    hook.handle({ session_id: "s", source: "startup" }, { env: b.env, now: Date.now, run: d.run, exists: () => true });
    assert.deepEqual(d.cmds().filter((c) => STATE_CHANGING.test(c)), []);
    assert.ok(d.cmds().includes("daemon status --format json"));
  } finally {
    b.release();
  }
});

test("3. runCtx with a grace: a timed-out child gets SIGTERM first and may exit cleanly; one that ignores it is killed after the grace", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-grace-"));
  try {
    const mark = join(dir, "term");
    const polite = join(dir, "polite.sh");
    writeFileSync(polite, `#!/bin/sh\ntrap 'echo term > "${mark}"; exit 0' TERM\nwhile :; do sleep 0.05; done\n`);
    chmodSync(polite, 0o755);
    const r = probe.runCtx([polite], { PATH: "/usr/bin:/bin" }, 300, { graceMs: 3_000 });
    assert.match(r.error ?? "", /did not answer in 0\.3 s/);
    assert.equal(existsSync(mark) && readFileSync(mark, "utf8").trim(), "term", "the child saw SIGTERM before any SIGKILL");

    const stubborn = join(dir, "stubborn.sh");
    writeFileSync(stubborn, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 0.05; done\n");
    chmodSync(stubborn, 0o755);
    const t = Date.now();
    const s = probe.runCtx([stubborn], { PATH: "/usr/bin:/bin" }, 200, { graceMs: 400 });
    assert.match(s.error ?? "", /did not answer/);
    assert.ok(Date.now() - t < 5_000, `bounded: ${Date.now() - t} ms`);

    const missing = probe.runCtx([join(dir, "no-such-ctx")], { PATH: "/usr/bin:/bin" }, 500, { graceMs: 500 });
    assert.match(missing.error ?? "", /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 4. LANG in the launchd environment.

test("4. install carries LANG and ctx's other launch-environment names into the plist; never CI or the embedding token", () => {
  const b = box();
  try {
    const env = { ...b.env, PATH: "/Users/example/.local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TMPDIR: "/var/folders/xx/T/", CTX_UPGRADE_AUTO: "off", CI: "true", CTX_SEMANTIC_EMBEDDING_TOKEN: "secret", UNRELATED: "x" };
    const check = (bin) => (bin === "plutil" ? { missing: false, code: 0, output: "OK" } : { missing: false, code: 113, output: "" });
    const r = launchd.install({ env, cliPath: "/Users/example/plugins/ctx-watch/scripts/ctx-watch.mjs", node: "/usr/local/bin/node", uid: 501, check, stateDir: join(b.root, "s"), exists: (p) => p === "/Users/example/.local/bin/ctx" });
    assert.equal(r.code, 0, r.text);
    const text = readFileSync(r.file, "utf8");
    assert.match(text, /<key>LANG<\/key>\s*<string>en_US\.UTF-8<\/string>/);
    assert.match(text, /<key>LC_ALL<\/key>\s*<string>en_US\.UTF-8<\/string>/);
    assert.match(text, /<key>TMPDIR<\/key>\s*<string>\/var\/folders\/xx\/T\/<\/string>/);
    assert.match(text, /<key>CTX_DATA_ROOT<\/key>/);
    assert.match(text, /<key>CTX_UPGRADE_AUTO<\/key>\s*<string>off<\/string>/);
    assert.doesNotMatch(text, /<key>CI<\/key>/);
    assert.doesNotMatch(text, /secret|TOKEN|UNRELATED/);
    assert.match(r.text, /LANG/);
  } finally {
    b.release();
  }
});

test("4. install from a shell without LANG still writes the plist and says what that costs", () => {
  const b = box();
  try {
    const env = { HOME: b.env.HOME, XDG_STATE_HOME: b.env.XDG_STATE_HOME, PATH: "/Users/example/.local/bin:/usr/bin:/bin" };
    const check = (bin) => (bin === "plutil" ? { missing: false, code: 0, output: "OK" } : { missing: false, code: 113, output: "" });
    const r = launchd.install({ env, cliPath: "/Users/example/plugins/ctx-watch/scripts/ctx-watch.mjs", node: "/usr/local/bin/node", uid: 501, check, stateDir: join(b.root, "s"), exists: (p) => p === "/Users/example/.local/bin/ctx" });
    assert.equal(r.code, 0);
    assert.match(r.text, /LANG is not set/);
    assert.match(r.text, /environment_invalid/);
    assert.doesNotMatch(readFileSync(r.file, "utf8"), /<key>LANG<\/key>/);
  } finally {
    b.release();
  }
});

// ---------------------------------------------------------------------------------------------
// 5. Keep raising it.

const T0 = 1_794_000_000_000;
const FAIL = { ok: false, reason: "the ctx daemon is not running", healed: null };

test("5. a popup that gave up unread re-arms after POPUP_REARM_MS on a still-failing tick, and not before", () => {
  const R = stateLib.POPUP_REARM_MS;
  assert.ok(R >= 60 * MIN && R <= 12 * 60 * MIN, `a few hours, not every tick: ${R} ms`);
  const unseen = { ...stateLib.EMPTY, episode: "down", strikes: 5, episodeKind: "daemon", kindStrikes: 5, downSince: T0, popupShown: { daemon: true, semantic: false, upgrade: false }, lastPopupAt: T0, popupUnseenAt: { daemon: T0, semantic: null, upgrade: null } };
  assert.equal(stateLib.step(unseen, FAIL, T0 + 5 * MIN).popup, false, "five minutes later: quiet");
  assert.equal(stateLib.step(unseen, FAIL, T0 + R - 1).popup, false);
  const again = stateLib.step(unseen, FAIL, T0 + R);
  assert.equal(again.popup, true, "re-armed");
  const seen = { ...unseen, popupUnseenAt: { daemon: null, semantic: null, upgrade: null } };
  assert.equal(stateLib.step(seen, FAIL, T0 + 24 * 60 * MIN).popup, false, "an acknowledged popup stays latched for the episode");
});

test("5. settling: exit 0 with `gave up:true` is shown but unseen (re-arms); exit 0 with OK clicked is seen; an outcome without the field counts as unseen", () => {
  const pending = { ...stateLib.EMPTY, episode: "down", strikes: 2, episodeKind: "daemon", kindStrikes: 2, popupPending: { token: "t1", since: T0, kind: "daemon" } };
  const outcome = (o) => ({ token: "t1", at: T0 + 3_600_000, bin: "/usr/bin/osascript", code: 0, signal: null, error: null, acknowledged: false, ...o });
  const gaveUp = stateLib.popupSettled(pending, outcome({ gaveUp: true }), T0 + 3_600_001).state;
  assert.equal(gaveUp.popupShown.daemon, true);
  assert.equal(gaveUp.popupUnseenAt.daemon, T0);
  const clicked = stateLib.popupSettled(pending, outcome({ gaveUp: false }), T0 + 10_000).state;
  assert.equal(clicked.popupShown.daemon, true);
  assert.equal(clicked.popupUnseenAt.daemon, null);
  const legacy = stateLib.popupSettled(pending, outcome({}), T0 + 10_000).state;
  assert.equal(legacy.popupUnseenAt.daemon, T0);
  const answeredAtOnce = stateLib.popupDelivered(pending, { started: true, seen: true, detail: "x" }, T0 + 1);
  assert.equal(answeredAtOnce.popupUnseenAt.daemon, null);
  const gaveUpAtOnce = stateLib.popupDelivered(pending, { started: true, seen: false, detail: "x" }, T0 + 1);
  assert.equal(gaveUpAtOnce.popupUnseenAt.daemon, T0 + 1);
});

test("5. the supervisor records osascript's `gave up:` answer (never osascript: a fake prints it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-gaveup-"));
  try {
    for (const [name, line, want] of [["gave", "button returned:, gave up:true", true], ["clicked", "button returned:OK, gave up:false", false]]) {
      const bin = join(dir, `osascript-${name}`);
      writeFileSync(bin, `#!/bin/sh\necho '${line}'\nexit 0\n`);
      chmodSync(bin, 0o755);
      const file = popupLib.outcomePath(dir, name);
      const r = await popupLib.showPopup({ text: "probe only; no dialog", bin, graceMs: 3_000, outcomeFile: file, token: name });
      assert.equal(r.started, true);
      assert.equal(r.seen, !want, `${name}: seen`);
      assert.equal(popupLib.readOutcome(file).gaveUp, want);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5. state.json keeps popupUnseenAt and the upgrade latch; a file without them reads as before", () => {
  const v = stateLib.validateState({ popupShown: { daemon: true, semantic: false }, popupUnseenAt: { daemon: T0, semantic: null, upgrade: null } }).state;
  assert.deepEqual(v.popupShown, { daemon: true, semantic: false, upgrade: false });
  assert.deepEqual(v.popupUnseenAt, { daemon: T0, semantic: null, upgrade: null });
  assert.deepEqual(stateLib.validateState({}).state.popupUnseenAt, { daemon: null, semantic: null, upgrade: null });
  assert.match(stateLib.validateState({ popupUnseenAt: { daemon: "soon" } }).problem ?? "", /popupUnseenAt/);
});

// ---------------------------------------------------------------------------------------------
// 6. Tell the agent.

const input = { session_id: "s-test", cwd: "/Users/example/repo", hook_event_name: "SessionStart", source: "startup" };

test("6. down: SessionStart adds hookSpecificOutput.additionalContext naming what is down, since when, and the repair", () => {
  const b = box();
  try {
    const d = ctxDouble();
    const out = hook.handle(input, { env: b.env, now: Date.now, run: d.run, exists: () => true });
    assert.match(out.systemMessage, /the ctx daemon is not running/);
    assert.equal(out.hookSpecificOutput?.hookEventName, "SessionStart");
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ctx daemon is not running/);
    assert.match(ctx, /since \d{4}-\d\d-\d\dT/);
    assert.match(ctx, /`ctx index mode auto`/);
    assert.match(ctx, /ctx-watch\.mjs'? repair/, "the agent-runnable repair, by its exact command");
    assert.match(ctx, /CI/);
    assert.match(ctx, /LANG/);
    assert.ok(ctx.length < 1_200, `one short block: ${ctx.length} chars`);
  } finally {
    b.release();
  }
});

test("6. since when: the timer's downSince when it has one", () => {
  const b = box();
  try {
    stateLib.writeState(stateLib.statePath(b.env), { ...stateLib.EMPTY, episode: "down", strikes: 40, episodeKind: "daemon", kindStrikes: 40, downSince: Date.UTC(2026, 10, 5, 13, 14, 23), lastTickAt: Date.now() });
    const out = hook.handle(input, { env: b.env, now: Date.now, run: ctxDouble().run, exists: () => true });
    assert.match(out.hookSpecificOutput.additionalContext, /since 2026-11-05T13:14:23/);
  } finally {
    b.release();
  }
});

test("6. stuck: the agent gets the release sequence, marked observed-not-documented, and told not to run it while an owner is alive", () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: deadPid(), ageMs: 40 * MIN });
    const d = ctxDouble({ upgrade: upgradeAt("quiescing", Date.now() - 2 * 60 * MIN) });
    const out = hook.handle(input, { env: b.env, now: Date.now, run: d.run, exists: () => true });
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /stuck/);
    assert.match(ctx, /ctx upgrade disable/);
    assert.match(ctx, /ctx upgrade --dry-run/);
    assert.match(ctx, /observed.*not documented/);
    assert.match(ctx, /ctx index mode auto/);
  } finally {
    b.release();
  }
});

test("6. upgrading: the agent is told not to heal", () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: process.pid });
    const d = ctxDouble({ upgrade: upgradeAt("quiescing", Date.now() - MIN) });
    const out = hook.handle(input, { env: b.env, now: Date.now, run: d.run, exists: () => true });
    assert.match(out.hookSpecificOutput.additionalContext, /upgrade is in progress/);
    assert.match(out.hookSpecificOutput.additionalContext, /[Dd]o not run `ctx index mode auto`/);
  } finally {
    b.release();
  }
});

test("6. healthy: nothing at all, and no extra ctx call", () => {
  const b = box();
  try {
    const d = ctxDouble({ status: HEALTHY });
    const now = () => JSON.parse(HEALTHY).daemon.jobs.core_refresh.last_run_at_ms + MIN;
    assert.equal(hook.handle(input, { env: b.env, now, run: d.run }), null);
    assert.deepEqual(d.cmds(), ["daemon status --format json"]);
  } finally {
    b.release();
  }
});

test("6. a semantic index that is not ready is the user's line only: the agent's context is for ctx being down", () => {
  const b = box();
  try {
    const j = JSON.parse(HEALTHY);
    j.daemon.jobs.semantic_index.status = "failed";
    const now = () => j.daemon.jobs.core_refresh.last_run_at_ms + MIN;
    const out = hook.handle(input, { env: b.env, now, run: ctxDouble({ status: JSON.stringify(j) }).run });
    assert.match(out.systemMessage, /semantic index is not ready/);
    assert.equal(out.hookSpecificOutput, undefined);
  } finally {
    b.release();
  }
});
