// test/cli.test.mjs — main(argv, deps) for every verb, with the probes, popup, plutil and
// launchctl injected: check prints the line or nothing (exit 0 always); tick drives the episode
// through strike, down with one delivered popup, a popup that failed and is retried, a popup
// that failed after the grace (a fake osascript under the real supervisor) and is reopened, and
// recovery, and leaves the state file; install writes the plist (state directory and ctx
// pinned) and records the interval; the timer's own arguments reach the same state file the
// hook reads; status reads it all back; prune rotates and removes. Then the script as a
// process: help, an unknown verb, `check --json` against a fake ctx on PATH, and a PATH that
// cannot shadow a pinned `--ctx`.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, HELP, CLI_PATH } from "../scripts/ctx-watch.mjs";
import { statePath, readState, writeState, EMPTY } from "../lib/state.mjs";
import { LABEL } from "../lib/launchd.mjs";
import { MAX_LOG_BYTES } from "../lib/retention.mjs";
import { showPopup, readOutcome } from "../lib/popup.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HEALTHY = readFileSync(join(FIX_DIR, "ctx-daemon-status.txt"), "utf8");
const NOT_RUNNING = readFileSync(join(FIX_DIR, "ctx-daemon-status-not-running.txt"), "utf8");
const MODE = readFileSync(join(FIX_DIR, "ctx-index-mode.txt"), "utf8");
const NOW = JSON.parse(HEALTHY).daemon.jobs.core_refresh.last_run_at_ms + 60_000;
const good = (stdout) => ({ code: 0, stdout, stderr: "" });
const ctxExists = (p) => p === "/Users/example/.local/bin/ctx";

/** A ctx double: `daemon status` answers from `statuses` in order (the last repeats); heal reports not running. */
function fakeCtx(statuses) {
  const calls = [];
  let i = 0;
  const run = (argv) => {
    calls.push(argv.join(" "));
    if (argv[1] === "daemon") return good(statuses[Math.min(i++, statuses.length - 1)]);
    if (argv[3] === "auto") return good(NOT_RUNNING);
    return good(MODE);
  };
  return { calls, run };
}

function box() {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-cli-"));
  const env = { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), PATH: "/Users/example/.local/bin:/usr/bin:/bin" };
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}
const shownPopup = async () => ({ started: true, detail: "popup started (test)" });

test("parseArgs: verb, --key value, --flag; a stray positional is refused", () => {
  assert.deepEqual(parseArgs([]), { verb: "help", opts: {} });
  assert.deepEqual(parseArgs(["check", "--json"]), { verb: "check", opts: { json: true } });
  assert.deepEqual(parseArgs(["install", "--interval", "120"]), { verb: "install", opts: { interval: "120" } });
  assert.deepEqual(parseArgs(["tick", "--state-dir", "/Users/example/s", "--ctx", "/opt/ctx"]), { verb: "tick", opts: { "state-dir": "/Users/example/s", ctx: "/opt/ctx" } });
  assert.throws(() => parseArgs(["check", "now"]), /unexpected argument "now"/);
});

test("help and unknown verbs; --state-dir and --ctx need a value", async () => {
  assert.deepEqual(await main(["help"]), { code: 0, text: HELP });
  assert.deepEqual(await main([]), { code: 0, text: HELP });
  const r = await main(["nope"]);
  assert.equal(r.code, 2);
  assert.match(r.text, /^ctx-watch: unknown verb "nope"\n/);
  assert.equal((await main(["check", "extra"])).code, 2);
  const noDir = await main(["status", "--state-dir"]);
  assert.equal(noDir.code, 2);
  assert.match(noDir.text, /^ctx-watch: --state-dir needs a value\n/);
  assert.match((await main(["check", "--ctx"])).text, /^ctx-watch: --ctx needs a value\n/);
});

test("check: healthy prints nothing; failing prints the needs-you line; --json the whole result; exit 0 either way", async () => {
  const b = box();
  try {
    const ok = await main(["check"], { env: b.env, now: () => NOW, run: fakeCtx([HEALTHY]).run });
    assert.deepEqual(ok, { code: 0, text: "" });
    const bad = await main(["check"], { env: b.env, now: () => NOW, run: fakeCtx([NOT_RUNNING]).run, exists: () => true });
    assert.equal(bad.code, 0);
    assert.equal(bad.text, 'ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`');
    const json = JSON.parse((await main(["check", "--json"], { env: b.env, now: () => NOW, run: fakeCtx([NOT_RUNNING]).run, exists: () => true })).text);
    assert.equal(json.ok, false);
    assert.equal(json.first.ok, false);
    assert.equal(json.healed.attempted, true);
    assert.equal(json.at, NOW);
    assert.equal(json.timedOut, false);
    assert.equal(existsSync(statePath(b.env)), false, "check writes no state");
  } finally {
    b.release();
  }
});

test("--ctx pins the executable for every ctx spawn, whatever PATH holds", async () => {
  const b = box();
  try {
    const { calls, run } = fakeCtx([NOT_RUNNING]);
    await main(["check", "--ctx", "/opt/ctx/bin/ctx"], { env: { ...b.env, PATH: "/tmp/shadow:/usr/bin" }, now: () => NOW, run, exists: () => true });
    assert.deepEqual(calls, ["/opt/ctx/bin/ctx daemon status --format json", "/opt/ctx/bin/ctx index mode --format json", "/opt/ctx/bin/ctx index mode auto --format json", "/opt/ctx/bin/ctx daemon status --format json"]);
    const rel = fakeCtx([HEALTHY]);
    await main(["tick", "--ctx", "bin/ctx"], { env: b.env, now: () => NOW, run: rel.run, cwd: "/opt/ctx" });
    assert.equal(rel.calls[0], "/opt/ctx/bin/ctx daemon status --format json", "a relative --ctx is resolved against cwd, never looked up");
  } finally {
    b.release();
  }
});

test("tick: strike, then down with one popup, stays down silently, recovers and re-arms; state on disk each time", async () => {
  const b = box();
  try {
    const popups = [];
    const popup = async (o) => (popups.push(o.text), { started: true, detail: "popup started (test)" });
    const deps = (statuses, at) => ({ env: b.env, now: () => at, run: fakeCtx(statuses).run, exists: () => true, popup });
    const file = statePath(b.env);

    const t1 = await main(["tick"], deps([NOT_RUNNING], NOW));
    assert.equal(t1.code, 0);
    assert.match(t1.text, /^\d{4}-.*Z fail: the ctx daemon is not running .* \| heal: `ctx index mode auto --format json`: daemon running = false, supervisor "fallback" \| episode strike, strikes 1$/);
    assert.equal(popups.length, 0);
    assert.equal(readState(file).episode, "strike");

    const t2 = await main(["tick"], deps([NOT_RUNNING], NOW + 300_000));
    assert.match(t2.text, /episode down, strikes 2\npopup started \(test\)$/);
    assert.equal(popups.length, 1);
    assert.match(popups[0], /^ctx-watch: the ctx daemon is not running .*; fix: `ctx index mode auto`\n\nThe daemon has failed 2 checks in a row \(since \d{4}-.*Z\)\. Open a Terminal and run the fix; ctx-watch checks again in 300 s\.$/);
    assert.equal(readState(file).popupShown, true);
    assert.equal(readState(file).lastPopupAt, NOW + 300_000);

    const t3 = await main(["tick"], deps([NOT_RUNNING], NOW + 600_000));
    assert.match(t3.text, /episode down, strikes 3$/);
    assert.equal(popups.length, 1, "one popup per episode");

    const t4 = await main(["tick"], deps([HEALTHY], NOW + 900_000));
    assert.match(t4.text, /^\d{4}-.*Z pass: daemon running \(pid 1706\), supervisor installed, core_refresh \d+m ago \| episode up, strikes 0$/);
    const s = readState(file);
    assert.deepEqual({ episode: s.episode, strikes: s.strikes, popupShown: s.popupShown, lastTickAt: s.lastTickAt }, { episode: "up", strikes: 0, popupShown: false, lastTickAt: NOW + 900_000 });

    await main(["tick"], deps([NOT_RUNNING], NOW + 1_200_000));
    await main(["tick"], deps([NOT_RUNNING], NOW + 1_500_000));
    assert.equal(popups.length, 2, "a new episode pops again");
  } finally {
    b.release();
  }
});

test("tick: a popup that could not be delivered is said, recorded, and tried again on the next failing tick; a delivery then latches", async () => {
  const b = box();
  try {
    const file = statePath(b.env);
    const outcomes = [{ started: false, detail: "popup not shown: spawn /usr/bin/osascript ENOENT" }, { started: true, detail: "popup started (test)" }];
    let shown = 0;
    const popup = async () => (shown++, outcomes.shift());
    const deps = (at) => ({ env: b.env, now: () => at, run: fakeCtx([NOT_RUNNING]).run, exists: () => true, popup });
    await main(["tick"], deps(NOW));
    const t2 = await main(["tick"], deps(NOW + 1));
    assert.match(t2.text, /episode down, strikes 2\npopup not shown: spawn \/usr\/bin\/osascript ENOENT; will try again on the next failing tick$/);
    let s = readState(file);
    assert.deepEqual({ popupShown: s.popupShown, popupFailedAt: s.popupFailedAt, popupFailReason: s.popupFailReason, lastPopupAt: s.lastPopupAt }, { popupShown: false, popupFailedAt: NOW + 1, popupFailReason: "popup not shown: spawn /usr/bin/osascript ENOENT", lastPopupAt: null });
    const st = await main(["status"], { env: b.env, now: () => NOW + 2, check: () => ({ missing: true, code: null, output: "" }) });
    assert.match(st.text, /\nepisode: down \(strikes 2, down since \d{4}-.*Z, popup not shown \d{4}-.*Z: popup not shown: spawn \/usr\/bin\/osascript ENOENT\)\n/);
    const t3 = await main(["tick"], deps(NOW + 2));
    assert.equal(shown, 2, "tried again");
    assert.match(t3.text, /episode down, strikes 3\npopup started \(test\)$/);
    s = readState(file);
    assert.deepEqual({ popupShown: s.popupShown, popupFailedAt: s.popupFailedAt, lastPopupAt: s.lastPopupAt }, { popupShown: true, popupFailedAt: null, lastPopupAt: NOW + 2 });
    await main(["tick"], deps(NOW + 3));
    assert.equal(shown, 2, "latched");
  } finally {
    b.release();
  }
});

test("tick: a popup alive at the grace that later exits 7 never latches; the next failing tick reads the supervisor's outcome, reopens the episode and pops again (fake osascript, never a dialog)", async () => {
  const b = box();
  try {
    const file = statePath(b.env);
    const dir = join(b.env.XDG_STATE_HOME, "ctx-watch");
    mkdirSync(b.root, { recursive: true });
    const fake = join(b.root, "osascript-7");
    writeFileSync(fake, "#!/bin/sh\n/bin/sleep 1.5\nexit 7\n");
    chmodSync(fake, 0o755);
    const real = (o) => showPopup({ ...o, bin: fake, graceMs: 150 });
    const deps = (at, popup) => ({ env: b.env, now: () => at, run: fakeCtx([NOT_RUNNING]).run, exists: () => true, popup });
    await main(["tick"], deps(NOW, () => assert.fail("strike 1: no popup")));
    const t2 = await main(["tick"], deps(NOW + 1, real));
    assert.match(t2.text, /episode down, strikes 2\npopup started \(.*osascript-7 under supervisor pid \d+, gives up after 3600 s\); delivered once it exits 0$/);
    let s = readState(file);
    assert.equal(s.popupShown, false, "alive at the grace is not delivered");
    assert.equal(s.popupPending.since, NOW + 1);
    const token = s.popupPending.token;
    const st = await main(["status"], { env: b.env, now: () => NOW + 2, check: () => ({ missing: true, code: null, output: "" }) });
    assert.match(st.text, /\nepisode: down \(strikes 2, down since \d{4}-.*Z, popup up since \d{4}-.*Z, not confirmed yet\)\n/);
    const blocked = await main(["tick"], deps(NOW + 2, () => assert.fail("no second dialog while the first may be up")));
    assert.match(blocked.text, /episode down, strikes 3$/);

    // The supervisor outlives this tick (detached) and records the late exit.
    const end = Date.now() + 10_000;
    while (readOutcome(join(dir, "popup.json"))?.token !== token && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readOutcome(join(dir, "popup.json"))?.code, 7);
    assert.equal(readState(file).popupShown, false, "the outcome file is the supervisor's; state.json is only the tick's");

    let asked = 0;
    const t4 = await main(["tick"], deps(NOW + 3, async () => (asked++, { started: true, detail: "popup started (test)" })));
    assert.equal(asked, 1, "the episode's popup reopened and was asked for again");
    assert.match(t4.text, /^popup not delivered: .*osascript-7 ended with exit 7 after the grace; the popup is due again\n\d{4}-.*Z fail: .*episode down, strikes 4\npopup started \(test\)$/);
    s = readState(file);
    assert.deepEqual({ popupShown: s.popupShown, popupPending: s.popupPending, popupFailReason: s.popupFailReason }, { popupShown: true, popupPending: null, popupFailReason: null });
  } finally {
    b.release();
  }
});

test("tick: a heal that brings the daemon back is a pass with the heal named, and no strike", async () => {
  const b = box();
  try {
    const { calls, run } = fakeCtx([NOT_RUNNING, HEALTHY]);
    const r = await main(["tick"], { env: b.env, now: () => NOW, run, exists: () => true, popup: () => assert.fail("no popup") });
    assert.match(r.text, /pass: daemon running .* \| heal: `ctx index mode auto --format json`: .* \| episode up, strikes 0$/);
    assert.equal(calls.length, 4);
    assert.equal(readState(statePath(b.env)).lastProbe.ok, true);
  } finally {
    b.release();
  }
});

test("tick: an unwritable state directory is said in the output, exit still 0", async () => {
  const b = box();
  try {
    const dir = join(b.env.XDG_STATE_HOME, "ctx-watch");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      const r = await main(["tick"], { env: b.env, now: () => NOW, run: fakeCtx([HEALTHY]).run });
      assert.equal(r.code, 0);
      assert.match(r.text, /\nstate not written to .*state\.json: /);
    } finally {
      chmodSync(dir, 0o755);
    }
  } finally {
    b.release();
  }
});

test("tick --state-dir: the timer's pinned directory is the state file, not the environment; the hook under the installing environment reads the same file", async () => {
  const b = box();
  try {
    // Installed from a shell with XDG_STATE_HOME; launchd runs the tick with no XDG_STATE_HOME and another HOME.
    const installEnv = b.env;
    const check = (bin) => (bin === "plutil" ? { missing: false, code: 0, output: "OK" } : { missing: false, code: 113, output: "" });
    const inst = await main(["install"], { env: installEnv, check, node: "/Users/example/bin/node", uid: 501, ctxExists });
    assert.equal(inst.code, 0, inst.text);
    const plist = readFileSync(inst.file, "utf8");
    const pinnedDir = /<string>--state-dir<\/string>\s*<string>([^<]+)<\/string>/.exec(plist)[1];
    assert.equal(pinnedDir, join(installEnv.XDG_STATE_HOME, "ctx-watch"));
    const launchdEnv = { HOME: join(b.root, "launchd-home"), PATH: "/usr/bin:/bin" };
    const t = await main(["tick", "--state-dir", pinnedDir, "--ctx", "/Users/example/.local/bin/ctx"], { env: launchdEnv, now: () => NOW, run: fakeCtx([HEALTHY]).run });
    assert.equal(t.code, 0, t.text);
    assert.equal(readState(statePath(installEnv)).lastTickAt, NOW, "the stamp landed where the hook (installing environment) looks");
    assert.equal(existsSync(statePath(launchdEnv)), false, "and not under launchd's HOME");
    assert.equal(readState(statePath(installEnv)).intervalS, 300, "install's interval survived the tick");
    const st = await main(["status", "--state-dir", pinnedDir], { env: launchdEnv, now: () => NOW + 1, check });
    assert.match(st.text, new RegExp(`^state file: ${statePath(installEnv).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\nctx: ctx\n`));
  } finally {
    b.release();
  }
});

test("install writes the plist, records the interval in the state file, and prints the bootstrap line; status reads it back; uninstall prints bootout", async () => {
  const b = box();
  try {
    const check = (bin) => (bin === "plutil" ? { missing: false, code: 0, output: "OK" } : { missing: false, code: 113, output: "" });
    const r = await main(["install", "--interval", "120"], { env: b.env, check, node: "/Users/example/bin/node", uid: 501, cwd: "/Users/example", ctxExists });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.file, join(b.env.XDG_STATE_HOME, "ctx-watch", "launchd", `${LABEL}.plist`));
    const text = readFileSync(r.file, "utf8");
    assert.match(text, /<integer>120<\/integer>/);
    assert.match(text, new RegExp(`<string>${CLI_PATH}</string>`), "the plist names this script by its absolute path");
    assert.match(text, /<string>--ctx<\/string>\s*<string>\/Users\/example\/.local\/bin\/ctx<\/string>/, "the ctx found on the installing PATH");
    assert.match(r.text, new RegExp(`launchctl bootstrap gui/501 ${r.file}`));
    assert.equal(readState(statePath(b.env)).intervalS, 120);

    const st = await main(["status"], { env: b.env, now: () => NOW, check, uid: 501 });
    assert.equal(st.code, 0);
    assert.equal(st.text, [`state file: ${statePath(b.env)}`, "ctx: ctx", "last tick: never", "last probe: never", "episode: up (strikes 0)", `plist: ${r.file} (every 120 s)`, `launchd: launchd does not have ${LABEL}`].join("\n"));

    await main(["tick"], { env: b.env, now: () => NOW - 1_000_000, run: fakeCtx([NOT_RUNNING]).run, exists: () => true, popup: shownPopup });
    const st2 = await main(["status"], { env: b.env, now: () => NOW, check: () => ({ missing: false, code: 0, output: "state = waiting\nlast exit code = 0\n" }), uid: 501 });
    assert.match(st2.text, /\nlast tick: \d{4}-.*Z \(overdue: more than 240 s ago\)\nlast probe: fail: the ctx daemon is not running .* at \d{4}-.*Z \| heal: `ctx index mode auto --format json`: .*\nepisode: strike \(strikes 1\)\n/);
    assert.match(st2.text, new RegExp(`\\nlaunchd: launchd has ${LABEL} \\(state = waiting, last exit code = 0\\)$`));

    const un = await main(["uninstall"], { env: b.env, uid: 501 });
    assert.match(un.text, new RegExp(`^To stop the timer, run:\\n  launchctl bootout gui/501/${LABEL}\\n`));
    assert.ok(existsSync(r.file), "uninstall removes nothing");
  } finally {
    b.release();
  }
});

test("install: a bad interval, a failed lint, or no ctx is exit 1 and no interval is recorded", async () => {
  const b = box();
  try {
    const r = await main(["install", "--interval", "abc"], { env: b.env, check: () => ({ missing: true, code: null, output: "" }), node: "/Users/example/bin/node", uid: 501, ctxExists });
    assert.equal(r.code, 1);
    assert.match(r.text, /^ctx-watch install: interval must be/);
    assert.equal(existsSync(statePath(b.env)), false);
    const tooLong = await main(["install", "--interval", "604801"], { env: b.env, check: () => ({ missing: true, code: null, output: "" }), node: "/Users/example/bin/node", uid: 501, ctxExists });
    assert.equal(tooLong.code, 1);
    assert.match(tooLong.text, /^ctx-watch install: interval must be a whole number of seconds, 30\.\.604800, got 604801/);
    assert.equal(existsSync(join(b.env.XDG_STATE_HOME, "ctx-watch")), false, "no plist, no state: refused before any artifact");
    const noValue = await main(["install", "--interval"], { env: b.env });
    assert.equal(noValue.code, 2);
    assert.match(noValue.text, /^ctx-watch: --interval needs a value\n/);
    const noCtx = await main(["install"], { env: b.env, check: () => ({ missing: true, code: null, output: "" }), node: "/Users/example/bin/node", uid: 501, ctxExists: () => false });
    assert.equal(noCtx.code, 1);
    assert.match(noCtx.text, /^ctx-watch install: no executable `ctx` on PATH \(\/Users\/example\/.local\/bin:\/usr\/bin:\/bin\)/);
    assert.equal(existsSync(statePath(b.env)), false);
  } finally {
    b.release();
  }
});

test("tick rotates a log over the bound before probing; prune rotates, removes rotated logs past --days and stray temp files, and prints the pruned line last", async () => {
  const b = box();
  try {
    const dir = join(b.env.XDG_STATE_HOME, "ctx-watch");
    const out = join(dir, "launchd", `${LABEL}.out.log`);
    mkdirSync(join(dir, "launchd"), { recursive: true });
    writeFileSync(out, "x".repeat(MAX_LOG_BYTES + 1));
    writeFileSync(join(dir, "errors.log"), "small\n");
    const t = await main(["tick"], { env: b.env, now: () => NOW, run: fakeCtx([HEALTHY]).run });
    assert.equal(t.code, 0);
    assert.match(t.text, new RegExp(`^rotated ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to .*\\.out\\.log\\.1\\n\\d{4}-.*Z pass: `));
    assert.equal(existsSync(out), false, "launchd opens a fresh one on the next run");
    assert.equal(statSync(`${out}.1`).size, MAX_LOG_BYTES + 1);
    assert.equal(readFileSync(join(dir, "errors.log"), "utf8"), "small\n", "a small log is left alone");

    // Age the rotated log past 30 days; leave a stray temp file from a crashed write, old too.
    const old = new Date(NOW - 31 * 86_400_000);
    utimesSync(`${out}.1`, old, old);
    writeFileSync(join(dir, "state.json.99999.tmp"), "{}");
    utimesSync(join(dir, "state.json.99999.tmp"), old, old);
    writeFileSync(join(dir, "launchd", `${LABEL}.err.log`), "e".repeat(MAX_LOG_BYTES + 5));
    const dry = await main(["prune", "--dry-run"], { env: b.env, now: () => NOW });
    assert.equal(dry.code, 0);
    assert.match(dry.text, new RegExp(`^would rotate .*\\.err\\.log to .*\\.err\\.log\\.1\\npruned: 2 file\\(s\\), ${MAX_LOG_BYTES + 1 + 2} bytes freed \\(dry run\\); kept 1$`), "the same plan as the real prune below");
    assert.ok(existsSync(`${out}.1`), "a dry run removes nothing");
    assert.ok(existsSync(join(dir, "launchd", `${LABEL}.err.log`)) && !existsSync(join(dir, "launchd", `${LABEL}.err.log.1`)), "and rotates nothing");
    const p = await main(["prune"], { env: b.env, now: () => NOW });
    assert.equal(p.code, 0);
    const lines = p.text.split("\n");
    assert.match(lines[0], /^rotated .*\.err\.log to .*\.err\.log\.1$/);
    assert.equal(lines.at(-1), `pruned: 2 file(s), ${MAX_LOG_BYTES + 1 + 2} bytes freed; kept 1`);
    assert.equal(existsSync(`${out}.1`), false);
    assert.equal(existsSync(join(dir, "state.json.99999.tmp")), false);
    assert.ok(existsSync(join(dir, "launchd", `${LABEL}.err.log.1`)), "just rotated: kept");
    assert.ok(existsSync(statePath(b.env)), "state.json is never pruned");
    assert.equal(readState(statePath(b.env)).lastTickAt, NOW);
    const bad = await main(["prune", "--days", "x"], { env: b.env });
    assert.equal(bad.code, 2);
    assert.match(bad.text, /^ctx-watch: --days must be a whole number of days, got "x"\n/);
    // A valueless --days is a usage error, not a one-day prune (Number(true) is 1).
    const yesterday = new Date(NOW - 2 * 86_400_000);
    utimesSync(join(dir, "launchd", `${LABEL}.err.log.1`), yesterday, yesterday);
    const valueless = await main(["prune", "--days"], { env: b.env, now: () => NOW });
    assert.equal(valueless.code, 2);
    assert.match(valueless.text, /^ctx-watch: --days needs a value\n/);
    assert.ok(existsSync(join(dir, "launchd", `${LABEL}.err.log.1`)), "nothing pruned");
    assert.equal((await main(["prune", "--days", "--dry-run"], { env: b.env, now: () => NOW })).code, 2, "a flag where the value belongs is no value");
    const none = await main(["prune"], { env: { XDG_STATE_HOME: join(b.root, "nowhere") }, now: () => NOW });
    assert.equal(none.text, "pruned: 0 file(s), 0 bytes freed; kept 0", "no state directory is nothing to do");
  } finally {
    b.release();
  }
});

/** A fake `ctx` on PATH that prints `status` for `daemon status` and the mode fixture for `index mode`. */
function fakeCtxBin(dir, status) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "status.json"), status);
  writeFileSync(join(bin, "mode.json"), MODE);
  const ctx = join(bin, "ctx");
  writeFileSync(ctx, `#!/bin/sh\ncase "$1 $2" in\n  "daemon status") cat "${join(bin, "status.json")}";;\n  "index mode") if [ "$3" = "auto" ]; then echo "Error: fake ctx does not heal" >&2; exit 1; fi; cat "${join(bin, "mode.json")}";;\n  *) echo "fake ctx: unknown $*" >&2; exit 2;;\nesac\n`);
  chmodSync(ctx, 0o755);
  return bin;
}

test("the script as a process: help on stdout, unknown verb on stderr with exit 2, check --json against a fake ctx, a PATH that cannot shadow --ctx", () => {
  const b = box();
  try {
    const help = spawnSync(process.execPath, [CLI_PATH, "help"], { encoding: "utf8", env: b.env });
    assert.equal(help.status, 0);
    assert.equal(help.stdout, HELP + "\n");
    const bad = spawnSync(process.execPath, [CLI_PATH, "nope"], { encoding: "utf8", env: b.env });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown verb "nope"/);
    assert.equal(bad.stdout, "");

    const bin = fakeCtxBin(b.root, NOT_RUNNING);
    const env = { ...b.env, PATH: `${bin}:/usr/bin:/bin`, CI: "true" };
    const r = spawnSync(process.execPath, [CLI_PATH, "check", "--json"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.match(j.reason, /not running/);
    assert.match(j.healed.detail, /^not attempted: \/Users\/example\/.ctx\/config.toml does not exist/, "the heal gate holds under a HOME with no ctx config");
    const plain = spawnSync(process.execPath, [CLI_PATH, "check"], { encoding: "utf8", env });
    assert.equal(plain.stdout, 'ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`\n');

    const fresh = JSON.parse(HEALTHY);
    fresh.daemon.jobs.core_refresh.last_run_at_ms = Date.now();
    const healthy = fakeCtxBin(join(b.root, "h"), JSON.stringify(fresh));
    const ok = spawnSync(process.execPath, [CLI_PATH, "check"], { encoding: "utf8", env: { ...env, PATH: `${healthy}:/usr/bin:/bin` } });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, "", "healthy prints nothing");

    // PATH says "not running" first; --ctx names the healthy one: the pin wins.
    const pinned = spawnSync(process.execPath, [CLI_PATH, "check", "--ctx", join(healthy, "ctx")], { encoding: "utf8", env: { ...env, PATH: `${bin}:${healthy}:/usr/bin:/bin` } });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(pinned.stdout, "", "the shadowing ctx on PATH was never run");
    const moved = spawnSync(process.execPath, [CLI_PATH, "check", "--ctx", join(b.root, "moved", "ctx")], { encoding: "utf8", env: { ...env, PATH: `${healthy}:/usr/bin:/bin` } });
    assert.equal(moved.status, 0);
    assert.ok(moved.stdout.startsWith(`ctx-watch: ctx could not run: ${join(b.root, "moved", "ctx")} does not ex`), moved.stdout);
    assert.match(moved.stdout, /; fix: `ctx docs show getting-started`\n$/, "a pinned ctx that is gone never falls back to PATH, where a healthy one sits");

    // A tick as a process: the popup is the real showPopup, but osascript is never reached
    // because the fake ctx heals nothing and this is strike 1.
    writeState(statePath(b.env), { ...EMPTY });
    const tick = spawnSync(process.execPath, [CLI_PATH, "tick", "--state-dir", join(b.env.XDG_STATE_HOME, "ctx-watch")], { encoding: "utf8", env });
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, /episode strike, strikes 1\n$/);
  } finally {
    b.release();
  }
});
