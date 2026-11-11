// test/repair.test.mjs — `ctx-watch repair`, the non-interactive repair an agent can run (0.3.0):
// the 2026-11-11 hand-run sequence (pause the ctx-watch timer; wait out a live or young upgrade
// handoff; `ctx upgrade disable`; `ctx upgrade --dry-run` to release a stuck `quiescing`;
// `ctx index mode auto`; verify) with its typed prompts turned into gates. ctx and launchctl are
// doubles; the handoff marker lives under a temp CTX_DATA_ROOT, never ~/.ctx; nothing reaches a
// real launchd domain. Every module is imported as a namespace so a checkout without the verb
// fails each test on its own assertion.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as cli from "../scripts/ctx-watch.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HEALTHY_RAW = JSON.parse(readFileSync(join(FIX_DIR, "ctx-daemon-status.txt"), "utf8"));
const NOT_RUNNING_RAW = JSON.parse(readFileSync(join(FIX_DIR, "ctx-daemon-status-not-running.txt"), "utf8"));
const MODE = readFileSync(join(FIX_DIR, "ctx-index-mode.txt"), "utf8");
const UPGRADE = JSON.parse(readFileSync(join(FIX_DIR, "ctx-upgrade-status.txt"), "utf8"));
const MIN = 60_000;
const good = (stdout) => ({ code: 0, stdout, stderr: "" });

/** The healthy capture with its core_refresh and semantic stamps moved to now (so freshness passes on the real clock). */
const healthy = () => {
  const j = structuredClone(HEALTHY_RAW);
  j.daemon.jobs.core_refresh.last_run_at_ms = Date.now() - MIN;
  if (j.daemon.jobs.semantic_index?.last_run_at_ms) j.daemon.jobs.semantic_index.last_run_at_ms = Date.now() - MIN;
  return JSON.stringify(j);
};
/** The 2026-11-11 11:11 shape: stopped, supervisor environment_invalid, restart_required (derived from the not-running capture). */
const brokenEnv = () => {
  const j = structuredClone(NOT_RUNNING_RAW);
  j.daemon.status = "stopped";
  j.daemon.supervisor.status = "environment_invalid";
  j.daemon.supervisor.environment_snapshot = { ...(j.daemon.supervisor.environment_snapshot ?? {}), restart_required: true };
  return JSON.stringify(j);
};
const upgradeJson = (status, { auto = true, attemptAtMs = Date.now() - 3 * 60 * MIN } = {}) =>
  JSON.stringify({ ...UPGRADE, auto_upgrade: { ...UPGRADE.auto_upgrade, enabled: auto }, state: { ...UPGRADE.state, status, last_attempt_at: new Date(attemptAtMs).toISOString() } });
const deadPid = () => spawnSync("/bin/sh", ["-c", "exit 0"]).pid;

function box() {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-repair-"));
  const env = { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), CTX_DATA_ROOT: join(root, "ctx"), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", CI: "true" };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}

function writeHandoff(env, { pid, phase = "ready", ageMs = 0 }) {
  const file = join(env.CTX_DATA_ROOT, "daemon", "upgrade-handoff.json");
  mkdirSync(dirname(file), { recursive: true });
  const at = Date.now() - ageMs;
  writeFileSync(file, JSON.stringify({ handoff_id: "ua_test", owner_pid: pid, phase, schema_version: 1, updated_at_ms: at }));
  utimesSync(file, at / 1000, at / 1000);
}

/**
 * A stateful ctx: `daemon status` answers `status`; `upgrade disable` turns auto off; `upgrade
 * --dry-run` releases `quiescing` to `dry_run` (the observed 2026-11-11 behaviour); `index mode
 * auto` makes the daemon healthy. `fail` names a command (argv after ctx, joined) that errors.
 */
function fakeCtx({ status = brokenEnv(), upgrade = "dry_run", auto = true, fail = null, healTo = healthy } = {}) {
  const s = { status, upgrade, auto };
  const calls = [];
  const run = (argv, env, timeoutMs, opts) => {
    const cmd = argv.slice(1).join(" ");
    calls.push({ cmd, env, timeoutMs, opts });
    if (fail && cmd.startsWith(fail)) return { code: 1, stdout: "", stderr: `Error: ${fail} failed (test)`, error: undefined };
    if (cmd === "daemon status --format json") return good(s.status);
    if (cmd === "upgrade status --format json") return good(upgradeJson(s.upgrade, { auto: s.auto }));
    if (cmd.startsWith("upgrade disable")) return (s.auto = false), good("✓ Automatic upgrades disabled\n");
    if (cmd === "upgrade --dry-run --format json") return (s.upgrade = s.upgrade === "quiescing" ? "dry_run" : s.upgrade), good(JSON.stringify({ ok: true, status: "dry_run", message: "ctx 2.3.0 would upgrade to 2.4.1." }));
    if (cmd === "index mode --format json") return good(MODE);
    if (cmd === "index mode auto --format json") {
      s.status = healTo();
      return good(JSON.stringify({ indexing: { mode: "auto" }, daemon: { running: true, pid: 1, supervisor: { status: "installed" } } }));
    }
    return { code: 2, stdout: "", stderr: `fake ctx: unexpected ${cmd}`, error: undefined };
  };
  return { s, calls, run, cmds: () => calls.map((c) => c.cmd) };
}

/** The `locale -a` the doubles answer with by default: a few of what macOS 15 lists. */
const HOST_LOCALES = ["C", "POSIX", "en_US", "en_US.UTF-8", "en_GB.UTF-8", "de_DE.UTF-8"];

/** The reach probe's label (0.4.0): a throwaway LaunchAgent repair bootstraps and boots out before it pauses anything. */
const PROBE = "com.jo-wolff-plugins.ctx-watch.reach-probe";
const SANDBOX_BOOTSTRAP = { missing: false, code: 5, output: "Bootstrap failed: 5: Input/output error\n" };

/**
 * A launchctl double: the GUI domain answers, the timer is loaded; `unreachable` makes the domain
 * print fail as launchctl does (112) and any bootstrap fail; `missing` makes launchctl not found;
 * `jobQuery` replaces the answer to `launchctl print gui/<uid>/<label>`; `onBootout` runs when
 * the timer is paused. The reach probe's calls go to `probe` (never `calls`, which is the
 * ctx-watch timer's and the locale lookups'): `probeBootstrap` and `probeBootout` replace their
 * answers (a function may throw), and `plists` keeps each probe plist as it was when bootstrapped,
 * with its path. A probe bootout while the probe is not loaded answers launchctl's 3 (no such
 * process). It also answers `defaults read -g AppleLocale` with `locale` (null: the key is
 * absent, exit 1, as `defaults` says for a missing key) and `locale -a` with `locales`.
 */
function fakeLaunchctl({ loaded = true, unreachable = false, bootstrapCode = 0, locale = null, locales = HOST_LOCALES, missing = false, jobQuery = null, onBootout = () => {}, probeBootstrap = null, probeBootout = null, probeLeftLoaded = false } = {}) {
  const calls = [];
  const probe = [];
  const plists = [];
  let probeLoaded = probeLeftLoaded;
  const answer = (a) => (typeof a === "function" ? a() : a);
  const check = (bin, args) => {
    if (bin === "defaults") {
      calls.push(`defaults ${args.join(" ")}`);
      assert.deepEqual(args, ["read", "-g", "AppleLocale"]);
      return locale === null ? { missing: false, code: 1, output: "The domain/default pair of (kCFPreferencesAnyApplication, AppleLocale) does not exist\n" } : { missing: false, code: 0, output: `${locale}\n` };
    }
    if (bin === "locale") {
      calls.push(`locale ${args.join(" ")}`);
      assert.deepEqual(args, ["-a"]);
      return { missing: false, code: 0, output: `${locales.join("\n")}\n` };
    }
    assert.equal(bin, "launchctl");
    const [verb, target, path] = args;
    if (verb === "bootstrap" && String(path).endsWith(`${PROBE}.plist`)) {
      probe.push(args.join(" "));
      if (missing) return { missing: true, code: null, output: "" };
      plists.push({ path, text: readFileSync(path, "utf8") });
      // launchd answers a bootstrap of a label it already has with 5 as well.
      const r = probeLoaded ? SANDBOX_BOOTSTRAP : answer(probeBootstrap) ?? (unreachable ? SANDBOX_BOOTSTRAP : { missing: false, code: 0, output: "" });
      if (r.code === 0) probeLoaded = true;
      return r;
    }
    if (verb === "bootout" && target.endsWith(`/${PROBE}`)) {
      probe.push(args.join(" "));
      if (missing) return { missing: true, code: null, output: "" };
      if (!probeLoaded) return { missing: false, code: 3, output: "Boot-out failed: 3: No such process\n" };
      const r = answer(probeBootout) ?? { missing: false, code: 0, output: "" };
      if (r.code === 0) probeLoaded = false;
      return r;
    }
    calls.push(args.join(" "));
    if (missing) return { missing: true, code: null, output: "" };
    if (verb === "print" && /^gui\/\d+$/.test(target)) return unreachable ? { missing: false, code: 112, output: `Bad request.\nCould not find domain for user gui: ${target.slice(4)}\n` } : { missing: false, code: 0, output: "domain" };
    if (verb === "print" && jobQuery) return jobQuery;
    if (verb === "print") return loaded ? { missing: false, code: 0, output: "state = not running\n" } : { missing: false, code: 113, output: "Could not find service" };
    if (verb === "bootout") return onBootout(), { missing: false, code: 0, output: "" };
    if (verb === "bootstrap") return unreachable ? SANDBOX_BOOTSTRAP : { missing: false, code: bootstrapCode, output: bootstrapCode ? "Bootstrap failed: 5: Input/output error" : "" };
    return { missing: false, code: 1, output: "?" };
  };
  return { calls, probe, plists, check, probeLoaded: () => probeLoaded };
}

const repair = (b, ctx, lc, extra = {}) => cli.main(["repair"], { env: b.env, run: ctx.run, check: lc.check, uid: 501, exists: () => true, sleep: () => {}, ...extra });
const parse = (r) => JSON.parse(r.text.split("\n")[0]);
const changing = (ctx) => ctx.cmds().filter((c) => /^(index mode auto|upgrade (disable|--dry-run))/.test(c));

test("7. repair: a stuck quiescing upgrade with a dead, stale owner is released and the daemon comes back, timer paused and restored", async () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: deadPid(), ageMs: 40 * MIN });
    const ctx = fakeCtx({ upgrade: "quiescing" });
    const lc = fakeLaunchctl();
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 0, r.text);
    assert.equal(j.ok, true);
    assert.equal(j.changed, true);
    assert.deepEqual(changing(ctx), ["upgrade disable", "upgrade --dry-run --format json", "index mode auto --format json"]);
    assert.ok(lc.calls.includes("bootout gui/501/com.jo-wolff-plugins.ctx-watch"), "paused");
    assert.ok(lc.calls.some((c) => c.startsWith("bootstrap gui/501 ") && c.endsWith("com.jo-wolff-plugins.ctx-watch.plist")), "restored");
    assert.deepEqual(j.timer, { wasLoaded: true, paused: true, restored: true });
    assert.deepEqual(j.verified, { running: true, status: "running", supervisor: "installed", restartRequired: false });
    assert.ok(ctx.calls.every((c) => !("CI" in c.env)), "every ctx spawn has CI removed");
    assert.equal(ctx.calls.find((c) => c.cmd === "index mode auto --format json").env.LANG, "en_US.UTF-8", "LANG reaches the heal");
    assert.match(r.text.split("\n").at(-1), /^ctx-watch repair: repaired/);
  } finally {
    b.release();
  }
});

test("7. repair refuses while the handoff owner is alive: nothing changed, timer untouched, non-zero exit naming the pid", async () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: process.pid });
    const ctx = fakeCtx({ upgrade: "quiescing" });
    const lc = fakeLaunchctl();
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.notEqual(r.code, 0);
    assert.equal(j.refused, true);
    assert.match(j.reason, new RegExp(`pid ${process.pid}`));
    assert.match(j.reason, /in progress/);
    assert.deepEqual(changing(ctx), []);
    assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), [], "the timer was not touched");
  } finally {
    b.release();
  }
});

test("7. repair refuses while the handoff marker is under 15 min old (owner dead) and says how long to wait", async () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: deadPid(), ageMs: 5 * MIN });
    const ctx = fakeCtx({ upgrade: "quiescing" });
    const lc = fakeLaunchctl();
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.notEqual(r.code, 0);
    assert.equal(j.refused, true);
    assert.match(j.reason, /15 min/);
    assert.match(j.reason, /wait (9|10) ?m/);
    assert.deepEqual(changing(ctx), []);
    assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), []);
  } finally {
    b.release();
  }
});

test("7. repair releases only a stuck `quiescing`: a `dry_run` state gets no --dry-run, and auto already off gets no disable", async () => {
  const b = box();
  try {
    const ctx = fakeCtx({ upgrade: "dry_run", auto: false });
    const r = await repair(b, ctx, fakeLaunchctl());
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(changing(ctx), ["index mode auto --format json"]);
    const steps = parse(r).steps.map((s) => s.name);
    assert.ok(steps.includes("disable-upgrades"), "the step is reported, as skipped");
    assert.match(parse(r).steps.find((s) => s.name === "release-upgrade").detail, /not quiescing/);
  } finally {
    b.release();
  }
});

test("7. repair restores the timer even when a step fails, and exits non-zero with ctx's own line", async () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: deadPid(), ageMs: 40 * MIN });
    const ctx = fakeCtx({ upgrade: "quiescing", fail: "upgrade disable" });
    const lc = fakeLaunchctl();
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 1);
    assert.equal(j.ok, false);
    assert.match(j.reason, /upgrade disable failed \(test\)/);
    assert.ok(lc.calls.includes("bootout gui/501/com.jo-wolff-plugins.ctx-watch"));
    assert.ok(lc.calls.some((c) => c.startsWith("bootstrap gui/501 ")), "restored after the failure");
    assert.equal(j.timer.restored, true);
    assert.deepEqual(changing(ctx), ["upgrade disable"], "stopped at the failed step");
  } finally {
    b.release();
  }
});

test("7. repair fails verification when the daemon does not come back, and still restores the timer", async () => {
  const b = box();
  try {
    const ctx = fakeCtx({ healTo: brokenEnv });
    const lc = fakeLaunchctl();
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 1);
    assert.match(j.reason, /verif/);
    assert.equal(j.timer.restored, true);
  } finally {
    b.release();
  }
});

test("7. repair on a healthy daemon changes nothing and says so (exit 0)", async () => {
  const b = box();
  try {
    const ctx = fakeCtx({ status: healthy() });
    const lc = fakeLaunchctl();
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 0);
    assert.equal(j.ok, true);
    assert.equal(j.changed, false);
    assert.deepEqual(changing(ctx), []);
    assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), []);
    assert.match(r.text.split("\n").at(-1), /healthy; nothing changed/);
  } finally {
    b.release();
  }
});

test("0.4.0 a healthy repair reports the timer as not checked (wasLoaded null), never false, and touches no launchd job, probe included", async () => {
  const b = box();
  try {
    const ctx = fakeCtx({ status: healthy() });
    const lc = fakeLaunchctl({ loaded: true });
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(j.timer, { wasLoaded: null, paused: false, restored: null }, "a loaded timer that was never asked about is not reported unloaded");
    assert.deepEqual(lc.calls.filter((c) => /^(bootout|bootstrap)/.test(c)), []);
    assert.deepEqual(lc.probe, [], "no reach probe on the healthy path");
  } finally {
    b.release();
  }
});

test("7. repair refuses before any change when the GUI launchd domain is not reachable from this shell", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({ unreachable: true });
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.notEqual(r.code, 0);
    assert.equal(j.refused, true);
    assert.match(j.reason, /gui\/501/);
    assert.deepEqual(changing(ctx), []);
  } finally {
    b.release();
  }
});

const timerBootouts = (lc) => lc.calls.filter((c) => c === "bootout gui/501/com.jo-wolff-plugins.ctx-watch");
const probeGone = (lc) => lc.plists.every((p) => !existsSync(dirname(p.path)));

test("0.4.0 repair refuses when launchctl can read gui/501 but not bootstrap into it (the sandboxed shell): exit 3, launchctl's error, the real timer never booted out, the probe's plist gone", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({ probeBootstrap: SANDBOX_BOOTSTRAP });
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 3, r.text);
    assert.equal(j.refused, true);
    assert.equal(j.changed, false);
    assert.match(j.reason, /Bootstrap failed: 5: Input\/output error/);
    assert.match(j.reason, /gui\/501/);
    assert.deepEqual(changing(ctx), [], "no ctx change");
    assert.deepEqual(timerBootouts(lc), [], "the ctx-watch timer was never paused");
    assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), [], "nothing but the probe touched launchd");
    assert.ok(lc.probe.some((c) => c.startsWith("bootstrap gui/501 ")), "the probe was tried");
    assert.equal(lc.plists.length, 1);
    assert.ok(probeGone(lc), "the probe's temp plist is removed");
    assert.equal(lc.probeLoaded(), false);
  } finally {
    b.release();
  }
});

test("0.4.0 the reach probe runs before the timer is paused: a throwaway /usr/bin/true LaunchAgent, bootstrapped and booted out, its plist removed", async () => {
  const b = box();
  try {
    writeHandoff(b.env, { pid: deadPid(), ageMs: 40 * MIN });
    const ctx = fakeCtx({ upgrade: "quiescing" });
    const order = [];
    const lc = fakeLaunchctl({ onBootout: () => order.push("timer bootout") });
    const check = (bin, args) => {
      if (bin === "launchctl" && String(args.at(-1)).includes(PROBE)) order.push(`probe ${args[0]}`);
      return lc.check(bin, args);
    };
    const r = await repair(b, ctx, { ...lc, check });
    assert.equal(r.code, 0, r.text);
    assert.equal(lc.plists.length, 1);
    const { text } = lc.plists[0];
    assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${PROBE.replaceAll(".", "\\.")}</string>`));
    assert.match(text, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/bin\/true<\/string>\s*<\/array>/);
    assert.doesNotMatch(text, /RunAtLoad<\/key>\s*<true\/>/, "the probe never runs anything");
    assert.ok(order.indexOf("probe bootstrap") >= 0 && order.indexOf("probe bootstrap") < order.indexOf("timer bootout"), order.join(", "));
    assert.ok(order.lastIndexOf("probe bootout") < order.indexOf("timer bootout"), `probe booted out before the timer is paused: ${order.join(", ")}`);
    assert.equal(lc.probeLoaded(), false, "the probe is not left loaded");
    assert.ok(probeGone(lc), "the probe's temp plist is removed");
  } finally {
    b.release();
  }
});

test("0.4.0 a probe that bootstraps but cannot be booted out refuses (bootout is how the timer is paused), plist removed, timer untouched", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({ probeBootout: { missing: false, code: 5, output: "Boot-out failed: 5: Input/output error\n" } });
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 3, r.text);
    assert.match(j.reason, /Boot-out failed: 5/);
    assert.match(j.reason, new RegExp(PROBE.replaceAll(".", "\\.")), "names the label left behind");
    assert.deepEqual(changing(ctx), []);
    assert.deepEqual(timerBootouts(lc), []);
    assert.ok(probeGone(lc));
  } finally {
    b.release();
  }
});

test("0.4.0 a launchctl that throws during the probe is a refusal, not a crash, and the probe's plist is still removed", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({
      probeBootstrap: () => {
        throw new Error("spawn launchctl EPERM");
      },
    });
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 3, r.text);
    assert.match(j.reason, /EPERM/);
    assert.deepEqual(changing(ctx), []);
    assert.deepEqual(timerBootouts(lc), []);
    assert.equal(lc.plists.length, 1);
    assert.ok(probeGone(lc));
  } finally {
    b.release();
  }
});

test("0.4.0 a probe an earlier run left loaded (killed mid-probe) is booted out first, so it does not read as a sandbox", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({ probeLeftLoaded: true });
    const r = await repair(b, ctx, lc);
    assert.equal(r.code, 0, r.text);
    assert.equal(lc.probeLoaded(), false);
    assert.ok(probeGone(lc));
  } finally {
    b.release();
  }
});

/** <CTX_DATA_ROOT>/daemon/supervisor-environment.json as ctx 2.3.0 writes it (values made up). */
function writeRecordedEnv(env, entries) {
  const file = join(env.CTX_DATA_ROOT, "daemon", "supervisor-environment.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema_version: 1, environment: entries }));
}
const RECORDED = [
  { name: "CTX_DATA_ROOT", value: "/Users/example/.ctx" },
  { name: "HOME", value: "/Users/example" },
  { name: "LANG", value: "de_DE.UTF-8" },
  { name: "PATH", value: "/usr/bin:/bin" },
  { name: "TMPDIR", value: "/var/folders/xx/T/" },
];

test("8. no LANG in this shell (Claude Desktop under launchd): repair takes the LANG ctx itself recorded, passes it to every ctx call, and says where it came from", async () => {
  const b = box();
  try {
    const { LANG: _l, ...noLang } = b.env;
    writeRecordedEnv(b.env, RECORDED);
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({ locale: "en_GB" });
    const r = await cli.main(["repair"], { env: noLang, run: ctx.run, check: lc.check, uid: 501, exists: () => true, sleep: () => {} });
    const j = parse(r);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(j.lang, { value: "de_DE.UTF-8", source: "ctx-recorded", skipped: [] });
    assert.equal(ctx.calls.find((c) => c.cmd === "index mode auto --format json").env.LANG, "de_DE.UTF-8");
    assert.ok(ctx.calls.every((c) => c.env.LANG === "de_DE.UTF-8"), "every ctx spawn carries it");
    assert.ok(!lc.calls.some((c) => c.startsWith("defaults")), "the recorded value wins; AppleLocale is not asked");
  } finally {
    b.release();
  }
});

test("8. no LANG and nothing recorded: repair derives it from AppleLocale (en_GB → en_GB.UTF-8)", async () => {
  const b = box();
  try {
    const { LANG: _l, ...noLang } = b.env;
    writeRecordedEnv(b.env, RECORDED.filter((e) => e.name !== "LANG"));
    const ctx = fakeCtx();
    const r = await cli.main(["repair"], { env: noLang, run: ctx.run, check: fakeLaunchctl({ locale: "en_GB" }).check, uid: 501, exists: () => true, sleep: () => {} });
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(parse(r).lang, { value: "en_GB.UTF-8", source: "AppleLocale", skipped: [] });
    assert.equal(ctx.calls.find((c) => c.cmd === "index mode auto --format json").env.LANG, "en_GB.UTF-8");
  } finally {
    b.release();
  }
});

test("8. LANG set in this shell: used as is (source env)", async () => {
  const b = box();
  try {
    writeRecordedEnv(b.env, RECORDED);
    const r = await cli.main(["repair"], { env: b.env, run: fakeCtx().run, check: fakeLaunchctl({ locale: "fr_FR" }).check, uid: 501, exists: () => true, sleep: () => {} });
    assert.deepEqual(parse(r).lang, { value: "en_US.UTF-8", source: "env", skipped: [] });
  } finally {
    b.release();
  }
});

test("8. no LANG anywhere (none in the shell, none recorded, no AppleLocale): repair refuses before any change, exit 3", async () => {
  const b = box();
  try {
    const { LANG: _l, ...noLang } = b.env;
    const ctx = fakeCtx();
    const lc = fakeLaunchctl();
    const r = await cli.main(["repair"], { env: noLang, run: ctx.run, check: lc.check, uid: 501, exists: () => true, sleep: () => {} });
    assert.equal(r.code, 3);
    assert.equal(parse(r).refused, true);
    assert.match(parse(r).reason, /LANG/);
    assert.match(parse(r).reason, /supervisor-environment\.json/);
    assert.match(parse(r).reason, /AppleLocale/);
    assert.deepEqual(changing(ctx), []);
    assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), []);
  } finally {
    b.release();
  }
});

test("8. a recorded LANG that is not a locale name is ignored, never passed to ctx", async () => {
  const b = box();
  try {
    const { LANG: _l, ...noLang } = b.env;
    writeRecordedEnv(b.env, [{ name: "LANG", value: "en_US.UTF-8; touch /tmp/x" }]);
    const r = await cli.main(["repair"], { env: noLang, run: fakeCtx().run, check: fakeLaunchctl({ locale: "en_US" }).check, uid: 501, exists: () => true, sleep: () => {} });
    const lang = parse(r).lang;
    assert.equal(lang.value, "en_US.UTF-8");
    assert.equal(lang.source, "AppleLocale");
    assert.deepEqual(lang.skipped.map((s) => s.source), ["ctx-recorded"], "the rejected recorded value is reported as skipped");
  } finally {
    b.release();
  }
});

test("7. repair refuses an indexing mode that is not auto: ctx-watch never flips a deliberate manual", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const run = (argv, ...rest) => (argv.slice(1).join(" ") === "index mode --format json" ? good(MODE.replace('"auto"', '"manual"')) : ctx.run(argv, ...rest));
    const r = await cli.main(["repair"], { env: b.env, run, check: fakeLaunchctl().check, uid: 501, exists: () => true, sleep: () => {} });
    assert.notEqual(r.code, 0);
    assert.match(parse(r).reason, /manual/);
    assert.deepEqual(changing(ctx), []);
  } finally {
    b.release();
  }
});

test("7. the timer not loaded: nothing to pause or restore, the repair still runs", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({ loaded: false });
    const r = await repair(b, ctx, lc);
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(parse(r).timer, { wasLoaded: false, paused: false, restored: null });
    assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), []);
  } finally {
    b.release();
  }
});

test("7. the repair verb is in the help, and the plugin ships a /ctx-watch:repair skill that runs it", () => {
  assert.match(cli.HELP, /^\s+repair\b/m);
  const skill = readFileSync(join(FIX_DIR, "..", "..", "skills", "repair", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: repair\ndescription: /);
  assert.match(skill, /scripts\/ctx-watch\.mjs" repair/);
});

// ---------------------------------------------------------------------------------------------
// Review round 1 (PR #109): each finding's reproduction, red at 98639c3.

/** The fake ctx with `upgrade status` answering `answer()` instead (an object: a run result). */
const withUpgrade = (ctx, answer) => (argv, env, t, o) => {
  if (argv.slice(1).join(" ") === "upgrade status --format json") {
    ctx.calls.push({ cmd: "upgrade status --format json", env, timeoutMs: t, opts: o });
    return answer();
  }
  return ctx.run(argv, env, t, o);
};
const restoredTimer = (lc) => lc.calls.some((c) => c.startsWith("bootstrap gui/501 "));

test("R1.1 a live upgrade that starts after the preflight (while the timer is being paused) stops the repair before any ctx change; the timer is restored", async () => {
  const b = box();
  try {
    const ctx = fakeCtx({ upgrade: "quiescing" });
    const lc = fakeLaunchctl({ onBootout: () => writeHandoff(b.env, { pid: process.pid }) });
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.notEqual(r.code, 0, r.text);
    assert.equal(j.ok, false);
    assert.match(j.reason, /in progress|alive/);
    assert.deepEqual(changing(ctx), [], "no disable, no release, no heal against a live owner");
    assert.ok(restoredTimer(lc), "timer restored");
    assert.equal(j.timer.restored, true);
  } finally {
    b.release();
  }
});

test("R1.1 a live upgrade that starts between the release and the heal stops the repair before `ctx index mode auto`", async () => {
  const b = box();
  try {
    const ctx = fakeCtx({ upgrade: "quiescing" });
    const run = (argv, env, t, o) => {
      const r = ctx.run(argv, env, t, o);
      if (argv.slice(1).join(" ") === "upgrade --dry-run --format json") writeHandoff(b.env, { pid: process.pid });
      return r;
    };
    const lc = fakeLaunchctl();
    const r = await cli.main(["repair"], { env: b.env, run, check: lc.check, uid: 501, exists: () => true, sleep: () => {} });
    const j = parse(r);
    assert.equal(r.code, 1, r.text);
    assert.match(j.reason, /in progress|alive/);
    assert.deepEqual(changing(ctx), ["upgrade disable", "upgrade --dry-run --format json"], "the heal never ran");
    assert.ok(restoredTimer(lc));
  } finally {
    b.release();
  }
});

test("R1.1 a different upgrade attempt by the time of the release is not released", async () => {
  const b = box();
  try {
    const ctx = fakeCtx({ upgrade: "quiescing" });
    let swapped = false;
    const run = withUpgrade(ctx, () => good(swapped ? JSON.stringify({ ...JSON.parse(upgradeJson("quiescing")), state: { ...JSON.parse(upgradeJson("quiescing")).state, attempt_id: "ua_other" } }) : upgradeJson(ctx.s.upgrade, { auto: ctx.s.auto })));
    const lc = fakeLaunchctl({ onBootout: () => (swapped = true) });
    const r = await cli.main(["repair"], { env: b.env, run, check: lc.check, uid: 501, exists: () => true, sleep: () => {} });
    assert.notEqual(r.code, 0, r.text);
    assert.match(parse(r).reason, /attempt/);
    assert.deepEqual(changing(ctx), []);
    assert.ok(restoredTimer(lc));
  } finally {
    b.release();
  }
});

test("R1.2 a step that throws is a structured failure (exit 1) and the timer is restored", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const run = (argv, env, t, o) => {
      if (argv.slice(1).join(" ") === "index mode auto --format json") throw new Error("mock heal threw");
      return ctx.run(argv, env, t, o);
    };
    const lc = fakeLaunchctl();
    const r = await cli.main(["repair"], { env: b.env, run, check: lc.check, uid: 501, exists: () => true, sleep: () => {} });
    const j = parse(r);
    assert.equal(r.code, 1);
    assert.equal(j.ok, false);
    assert.match(j.reason, /mock heal threw/);
    assert.ok(restoredTimer(lc));
    assert.equal(j.timer.restored, true);
  } finally {
    b.release();
  }
});

test("R1.2 a restore that fails is a failed repair, never a success", async () => {
  const b = box();
  try {
    const ctx = fakeCtx();
    const lc = fakeLaunchctl({ bootstrapCode: 5 });
    const r = await repair(b, ctx, lc);
    const j = parse(r);
    assert.equal(r.code, 1, r.text);
    assert.equal(j.ok, false);
    assert.equal(j.timer.restored, false);
    assert.match(j.reason, /timer/);
    assert.match(r.text.split("\n").at(-1), /^ctx-watch repair: failed: .*NOT restored/);
  } finally {
    b.release();
  }
});

test("R1.2 SIGTERM or SIGINT during the heal: the timer is restored, then the process exits 128 + the signal number", () => {
  const b = box();
  try {
    const program = join(b.root, "signalled.mjs");
    writeFileSync(
      program,
      `import { main } from ${JSON.stringify(new URL("../scripts/ctx-watch.mjs", import.meta.url).href)};
const SIG = process.argv[2];
const calls = [];
let healed = false;
const out = (x) => ({ code: 0, stdout: JSON.stringify(x), stderr: "" });
const run = (argv) => {
  const cmd = argv.slice(1).join(" ");
  if (cmd === "daemon status --format json") return out({ daemon: { running: healed, status: healed ? "running" : "stopped", supervisor: { status: "installed", environment_snapshot: { restart_required: false } } } });
  if (cmd === "upgrade status --format json") return out({ state: { status: "dry_run", attempt_id: "ua_x", last_attempt_at: "2026-11-05T00:00:00Z" }, auto_upgrade: { enabled: true } });
  if (cmd === "index mode --format json") return out({ indexing: { mode: "auto" }, config_path: "/x" });
  if (cmd === "index mode auto --format json") {
    process.kill(process.pid, SIG);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    healed = true;
    return out({ daemon: { running: true } });
  }
  return { code: 2, stdout: "", stderr: "unexpected " + cmd };
};
const check = (bin, args) => {
  calls.push(bin + " " + args.join(" "));
  if (bin === "launchctl" && args[0] === "print") return { missing: false, code: 0, output: "state = waiting" };
  return { missing: false, code: 0, output: "" };
};
const r = await main(["repair"], { env: ${JSON.stringify(b.env)}, run, check, uid: 501, exists: () => true, sleep: () => {} });
process.stdout.write(JSON.stringify({ code: r.code, report: JSON.parse(r.text.split("\\n")[0]), last: r.text.split("\\n").at(-1), calls }) + "\\n");
process.exit(r.code);
`,
    );
    for (const [sig, n] of [["SIGTERM", 15], ["SIGINT", 2]]) {
      const p = spawnSync(process.execPath, [program, sig], { encoding: "utf8", timeout: 20_000 });
      assert.equal(p.signal, null, `${sig}: the process handled the signal (stderr: ${p.stderr})`);
      assert.equal(p.status, 128 + n, `${sig}: exit ${p.status}; stderr: ${p.stderr}`);
      const o = JSON.parse(p.stdout.trim().split("\n").at(-1));
      assert.ok(o.calls.some((c) => c.startsWith("launchctl bootstrap gui/501 ") && c.endsWith("com.jo-wolff-plugins.ctx-watch.plist")), `${sig}: timer restored`);
      assert.equal(o.report.ok, false);
      assert.match(o.last, new RegExp(`interrupted by ${sig}`));
    }
  } finally {
    b.release();
  }
});

test("R1.3 `ctx upgrade status` failing, with no handoff marker to settle it, refuses the repair before any change: upgrade state unknown", async () => {
  const b = box();
  try {
    for (const answer of [() => ({ code: 1, stdout: "", stderr: "upgrade status unavailable" }), () => ({ code: null, stdout: "", stderr: "", error: "ctx upgrade status --format json did not answer in 10 s" }), () => good(upgradeJson("frobnicating"))]) {
      const ctx = fakeCtx();
      const lc = fakeLaunchctl();
      const r = await cli.main(["repair"], { env: b.env, run: withUpgrade(ctx, answer), check: lc.check, uid: 501, exists: () => true, sleep: () => {} });
      const j = parse(r);
      assert.equal(r.code, 3, r.text);
      assert.equal(j.refused, true);
      assert.match(j.reason, /upgrade state unknown/);
      assert.deepEqual(changing(ctx), []);
      assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), []);
    }
  } finally {
    b.release();
  }
});

test("R1.5 launchctl missing, or a timer query that cannot say whether the job is loaded, refuses the repair: nothing changed, timer untouched", async () => {
  const b = box();
  try {
    for (const opts of [{ missing: true }, { jobQuery: { missing: false, code: null, output: "query timed out" } }, { jobQuery: { missing: false, code: 5, output: "Input/output error" } }]) {
      const ctx = fakeCtx();
      const lc = fakeLaunchctl(opts);
      const r = await repair(b, ctx, lc);
      const j = parse(r);
      assert.equal(r.code, 3, `${JSON.stringify(opts)}: ${r.text}`);
      assert.equal(j.refused, true);
      assert.match(j.reason, /launchctl/);
      assert.deepEqual(changing(ctx), []);
      assert.deepEqual(lc.calls.filter((c) => /^boot/.test(c)), []);
    }
  } finally {
    b.release();
  }
});

test("R1.6 a fallback LANG this host has no locale for is skipped and reported: recorded zz_ZZ.UTF-8 falls through to AppleLocale", async () => {
  const b = box();
  try {
    const { LANG: _l, ...noLang } = b.env;
    writeRecordedEnv(b.env, [{ name: "LANG", value: "zz_ZZ.UTF-8" }]);
    const ctx = fakeCtx();
    const r = await cli.main(["repair"], { env: noLang, run: ctx.run, check: fakeLaunchctl({ locale: "en_GB" }).check, uid: 501, exists: () => true, sleep: () => {} });
    assert.equal(r.code, 0, r.text);
    const lang = parse(r).lang;
    assert.equal(lang.value, "en_GB.UTF-8");
    assert.equal(lang.source, "AppleLocale");
    assert.equal(lang.skipped.length, 1);
    assert.equal(lang.skipped[0].source, "ctx-recorded");
    assert.equal(lang.skipped[0].value, "zz_ZZ.UTF-8");
    assert.match(lang.skipped[0].why, /locale -a/);
    assert.ok(ctx.calls.every((c) => c.env.LANG === "en_GB.UTF-8"));
  } finally {
    b.release();
  }
});

test("R1.6 an AppleLocale pair the host has no locale for (en_DE) is not invented: with nothing else, repair refuses and names what it skipped", async () => {
  const b = box();
  try {
    const { LANG: _l, ...noLang } = b.env;
    const ctx = fakeCtx();
    const r = await cli.main(["repair"], { env: noLang, run: ctx.run, check: fakeLaunchctl({ locale: "en_DE" }).check, uid: 501, exists: () => true, sleep: () => {} });
    const j = parse(r);
    assert.equal(r.code, 3, r.text);
    assert.equal(j.lang.value, null);
    assert.deepEqual(j.lang.skipped.map((s) => [s.source, s.value]), [["AppleLocale", "en_DE.UTF-8"]]);
    assert.match(j.reason, /en_DE\.UTF-8/);
    assert.deepEqual(changing(ctx), []);
  } finally {
    b.release();
  }
});
