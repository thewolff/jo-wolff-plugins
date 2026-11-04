// test/cli.test.mjs — main(argv, deps) for every verb, with the probes, popup, plutil and
// launchctl injected: check prints the line or nothing (exit 0 always); tick drives the episode
// through strike, down with one popup, and recovery, and leaves the state file; install writes
// the plist and records the interval; status reads it all back. Then the script as a process:
// help, an unknown verb, and `check --json` against a fake ctx on PATH.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, HELP, CLI_PATH } from "../scripts/ctx-watch.mjs";
import { statePath, readState } from "../lib/state.mjs";
import { LABEL } from "../lib/launchd.mjs";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HEALTHY = readFileSync(join(FIX_DIR, "ctx-daemon-status.txt"), "utf8");
const NOT_RUNNING = readFileSync(join(FIX_DIR, "ctx-daemon-status-not-running.txt"), "utf8");
const MODE = readFileSync(join(FIX_DIR, "ctx-index-mode.txt"), "utf8");
const NOW = JSON.parse(HEALTHY).daemon.jobs.core_refresh.last_run_at_ms + 60_000;
const good = (stdout) => ({ code: 0, stdout, stderr: "" });

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

test("parseArgs: verb, --key value, --flag; a stray positional is refused", () => {
  assert.deepEqual(parseArgs([]), { verb: "help", opts: {} });
  assert.deepEqual(parseArgs(["check", "--json"]), { verb: "check", opts: { json: true } });
  assert.deepEqual(parseArgs(["install", "--interval", "120"]), { verb: "install", opts: { interval: "120" } });
  assert.throws(() => parseArgs(["check", "now"]), /unexpected argument "now"/);
});

test("help and unknown verbs", () => {
  assert.deepEqual(main(["help"]), { code: 0, text: HELP });
  assert.deepEqual(main([]), { code: 0, text: HELP });
  const r = main(["nope"]);
  assert.equal(r.code, 2);
  assert.match(r.text, /^ctx-watch: unknown verb "nope"\n/);
  assert.equal(main(["check", "extra"]).code, 2);
});

test("check: healthy prints nothing; failing prints the needs-you line; --json the whole result; exit 0 either way", () => {
  const b = box();
  try {
    const ok = main(["check"], { env: b.env, now: () => NOW, run: fakeCtx([HEALTHY]).run });
    assert.deepEqual(ok, { code: 0, text: "" });
    const bad = main(["check"], { env: b.env, now: () => NOW, run: fakeCtx([NOT_RUNNING]).run, exists: () => true });
    assert.equal(bad.code, 0);
    assert.equal(bad.text, 'ctx-watch: the ctx daemon is not running (.daemon.running = false, .daemon.status = "stale_lock"); fix: `ctx index mode auto`');
    const json = JSON.parse(main(["check", "--json"], { env: b.env, now: () => NOW, run: fakeCtx([NOT_RUNNING]).run, exists: () => true }).text);
    assert.equal(json.ok, false);
    assert.equal(json.first.ok, false);
    assert.equal(json.healed.attempted, true);
    assert.equal(json.at, NOW);
    assert.equal(existsSync(statePath(b.env)), false, "check writes no state");
  } finally {
    b.release();
  }
});

test("tick: strike, then down with one popup, stays down silently, recovers and re-arms; state on disk each time", () => {
  const b = box();
  try {
    const popups = [];
    const popup = (o) => (popups.push(o.text), { started: true, detail: "popup started (test)" });
    const deps = (statuses, at) => ({ env: b.env, now: () => at, run: fakeCtx(statuses).run, exists: () => true, popup });
    const file = statePath(b.env);

    const t1 = main(["tick"], deps([NOT_RUNNING], NOW));
    assert.equal(t1.code, 0);
    assert.match(t1.text, /^\d{4}-.*Z fail: the ctx daemon is not running .* \| heal: `ctx index mode auto --format json`: daemon running = false, supervisor "fallback" \| episode strike, strikes 1$/);
    assert.equal(popups.length, 0);
    assert.equal(readState(file).episode, "strike");

    const t2 = main(["tick"], deps([NOT_RUNNING], NOW + 300_000));
    assert.match(t2.text, /episode down, strikes 2\npopup started \(test\)$/);
    assert.equal(popups.length, 1);
    assert.match(popups[0], /^ctx-watch: the ctx daemon is not running .*; fix: `ctx index mode auto`\n\nThe daemon has failed 2 checks in a row \(since \d{4}-.*Z\)\. Open a Terminal and run the fix; ctx-watch checks again in 300 s\.$/);
    assert.equal(readState(file).popupShown, true);

    const t3 = main(["tick"], deps([NOT_RUNNING], NOW + 600_000));
    assert.match(t3.text, /episode down, strikes 3$/);
    assert.equal(popups.length, 1, "one popup per episode");

    const t4 = main(["tick"], deps([HEALTHY], NOW + 900_000));
    assert.match(t4.text, /^\d{4}-.*Z pass: daemon running \(pid 1706\), supervisor installed, core_refresh \d+m ago \| episode up, strikes 0$/);
    const s = readState(file);
    assert.deepEqual({ episode: s.episode, strikes: s.strikes, popupShown: s.popupShown, lastTickAt: s.lastTickAt }, { episode: "up", strikes: 0, popupShown: false, lastTickAt: NOW + 900_000 });

    main(["tick"], deps([NOT_RUNNING], NOW + 1_200_000));
    main(["tick"], deps([NOT_RUNNING], NOW + 1_500_000));
    assert.equal(popups.length, 2, "a new episode pops again");
  } finally {
    b.release();
  }
});

test("tick: a heal that brings the daemon back is a pass with the heal named, and no strike", () => {
  const b = box();
  try {
    const { calls, run } = fakeCtx([NOT_RUNNING, HEALTHY]);
    const r = main(["tick"], { env: b.env, now: () => NOW, run, exists: () => true, popup: () => assert.fail("no popup") });
    assert.match(r.text, /pass: daemon running .* \| heal: `ctx index mode auto --format json`: .* \| episode up, strikes 0$/);
    assert.equal(calls.length, 4);
    assert.equal(readState(statePath(b.env)).lastProbe.ok, true);
  } finally {
    b.release();
  }
});

test("tick: an unwritable state directory is said in the output, exit still 0", () => {
  const b = box();
  try {
    const dir = join(b.env.XDG_STATE_HOME, "ctx-watch");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      const r = main(["tick"], { env: b.env, now: () => NOW, run: fakeCtx([HEALTHY]).run });
      assert.equal(r.code, 0);
      assert.match(r.text, /\nstate not written to .*state\.json: /);
    } finally {
      chmodSync(dir, 0o755);
    }
  } finally {
    b.release();
  }
});

test("install writes the plist, records the interval in the state file, and prints the bootstrap line; status reads it back; uninstall prints bootout", () => {
  const b = box();
  try {
    const check = (bin) => (bin === "plutil" ? { missing: false, code: 0, output: "OK" } : { missing: false, code: 113, output: "" });
    const r = main(["install", "--interval", "120"], { env: b.env, check, node: "/Users/example/bin/node", uid: 501, cwd: "/Users/example" });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.file, join(b.env.XDG_STATE_HOME, "ctx-watch", "launchd", `${LABEL}.plist`));
    const text = readFileSync(r.file, "utf8");
    assert.match(text, /<integer>120<\/integer>/);
    assert.match(text, new RegExp(`<string>${CLI_PATH}</string>`), "the plist names this script by its absolute path");
    assert.match(r.text, new RegExp(`launchctl bootstrap gui/501 ${r.file}`));
    assert.equal(readState(statePath(b.env)).intervalS, 120);

    const st = main(["status"], { env: b.env, now: () => NOW, check, uid: 501 });
    assert.equal(st.code, 0);
    assert.equal(st.text, [`state file: ${statePath(b.env)}`, "last tick: never", "last probe: never", "episode: up (strikes 0)", `plist: ${r.file} (every 120 s)`, `launchd: launchd does not have ${LABEL}`].join("\n"));

    main(["tick"], { env: b.env, now: () => NOW - 1_000_000, run: fakeCtx([NOT_RUNNING]).run, exists: () => true, popup: () => ({ started: true, detail: "x" }) });
    const st2 = main(["status"], { env: b.env, now: () => NOW, check: () => ({ missing: false, code: 0, output: "state = waiting\nlast exit code = 0\n" }), uid: 501 });
    assert.match(st2.text, /\nlast tick: \d{4}-.*Z \(overdue: more than 240 s ago\)\nlast probe: fail: the ctx daemon is not running .* at \d{4}-.*Z \| heal: `ctx index mode auto --format json`: .*\nepisode: strike \(strikes 1\)\n/);
    assert.match(st2.text, new RegExp(`\\nlaunchd: launchd has ${LABEL} \\(state = waiting, last exit code = 0\\)$`));

    const un = main(["uninstall"], { env: b.env, uid: 501 });
    assert.match(un.text, new RegExp(`^To stop the timer, run:\\n  launchctl bootout gui/501/${LABEL}\\n`));
    assert.ok(existsSync(r.file), "uninstall removes nothing");
  } finally {
    b.release();
  }
});

test("install: a bad interval or a failed lint is exit 1 and no interval is recorded", () => {
  const b = box();
  try {
    const r = main(["install", "--interval", "abc"], { env: b.env, check: () => ({ missing: true, code: null, output: "" }), node: "/Users/example/bin/node", uid: 501 });
    assert.equal(r.code, 1);
    assert.match(r.text, /^ctx-watch install: interval must be/);
    assert.equal(existsSync(statePath(b.env)), false);
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

test("the script as a process: help on stdout, unknown verb on stderr with exit 2, check --json against a fake ctx", () => {
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
  } finally {
    b.release();
  }
});
