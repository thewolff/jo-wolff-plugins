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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

/**
 * A launchctl double: the GUI domain answers, the timer is loaded; `unreachable` makes the domain
 * print fail as launchctl does (112). It also answers `defaults read -g AppleLocale` with
 * `locale` (null: the key is absent, exit 1, as `defaults` says for a missing key).
 */
function fakeLaunchctl({ loaded = true, unreachable = false, bootstrapCode = 0, locale = null } = {}) {
  const calls = [];
  const check = (bin, args) => {
    if (bin === "defaults") {
      calls.push(`defaults ${args.join(" ")}`);
      assert.deepEqual(args, ["read", "-g", "AppleLocale"]);
      return locale === null ? { missing: false, code: 1, output: "The domain/default pair of (kCFPreferencesAnyApplication, AppleLocale) does not exist\n" } : { missing: false, code: 0, output: `${locale}\n` };
    }
    assert.equal(bin, "launchctl");
    calls.push(args.join(" "));
    const [verb, target] = args;
    if (verb === "print" && /^gui\/\d+$/.test(target)) return unreachable ? { missing: false, code: 112, output: `Bad request.\nCould not find domain for user gui: ${target.slice(4)}\n` } : { missing: false, code: 0, output: "domain" };
    if (verb === "print") return loaded ? { missing: false, code: 0, output: "state = not running\n" } : { missing: false, code: 113, output: "Could not find service" };
    if (verb === "bootout") return { missing: false, code: 0, output: "" };
    if (verb === "bootstrap") return { missing: false, code: bootstrapCode, output: bootstrapCode ? "Bootstrap failed: 5: Input/output error" : "" };
    return { missing: false, code: 1, output: "?" };
  };
  return { calls, check };
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
    assert.deepEqual(j.lang, { value: "de_DE.UTF-8", source: "ctx-recorded" });
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
    assert.deepEqual(parse(r).lang, { value: "en_GB.UTF-8", source: "AppleLocale" });
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
    assert.deepEqual(parse(r).lang, { value: "en_US.UTF-8", source: "env" });
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
    assert.deepEqual(parse(r).lang, { value: "en_US.UTF-8", source: "AppleLocale" });
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
