// test/launchd.test.mjs — the plist (content, absolute paths, the pinned state directory and
// ctx, interval), install (write, lint, the bootstrap line with its paths shell-quoted; plutil
// and launchctl injected, never run; ctx resolved through an injected `exists`), uninstall,
// loaded; and the popup's script and delivery (a spawn double for the lifecycle, real children
// that are not osascript for the error and early-exit paths; never a dialog).

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, DEFAULT_PATH, plistPath, plistText, install, uninstall, loaded, dedupePath, resolveCtx, shellQuote } from "../lib/launchd.mjs";
import { dialogScript, showPopup, OSASCRIPT, GIVE_UP_SECS, GRACE_MS } from "../lib/popup.mjs";

const NODE = "/Users/example/.local/bin/node";
const CLI = "/Users/example/plugins/ctx-watch/scripts/ctx-watch.mjs";
const LOGS = "/Users/example/.local/state/ctx-watch/launchd";
const STATE = "/Users/example/.local/state/ctx-watch";
const CTX_BIN = "/Users/example/.local/bin/ctx";
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("plistPath is under <state>/launchd; a given state directory wins over the environment", () => {
  assert.equal(plistPath({ XDG_STATE_HOME: "/Users/example/s" }), `/Users/example/s/ctx-watch/launchd/${LABEL}.plist`);
  assert.equal(plistPath({ XDG_STATE_HOME: "/Users/example/s" }, LABEL, "/Volumes/x/ctx-watch"), `/Volumes/x/ctx-watch/launchd/${LABEL}.plist`);
  assert.equal(LABEL, "com.jo-wolff-plugins.ctx-watch");
});

test("plistText: label, `node <cli> tick --state-dir <state> --ctx <ctx>`, StartInterval, RunAtLoad, logs beside the plist, PATH, no CI", () => {
  const text = plistText({ node: NODE, cliPath: CLI, interval: 300, logDir: LOGS, path: "/Users/example/.local/bin:/usr/bin:/bin", stateDir: STATE, ctx: CTX_BIN });
  assert.match(text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  assert.match(text, new RegExp(`<key>ProgramArguments</key>\\s*<array>\\s*<string>${NODE}</string>\\s*<string>${CLI}</string>\\s*<string>tick</string>\\s*<string>--state-dir</string>\\s*<string>${STATE}</string>\\s*<string>--ctx</string>\\s*<string>${CTX_BIN}</string>\\s*</array>`));
  assert.match(text, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, new RegExp(`<key>StandardOutPath</key>\\s*<string>${LOGS}/${LABEL}.out.log</string>`));
  assert.match(text, new RegExp(`<key>StandardErrorPath</key>\\s*<string>${LOGS}/${LABEL}.err.log</string>`));
  assert.match(text, /<key>PATH<\/key>\s*<string>\/Users\/example\/.local\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.doesNotMatch(text, /\bCI\b/);
  assert.doesNotMatch(text, /KeepAlive/, "a timer, not a kept-alive job");
  for (const s of text.matchAll(/<string>([^<]*)<\/string>/g)) {
    const v = s[1];
    if (v === LABEL || v === "tick" || v === "Background" || v.startsWith("--") || v.includes(":")) continue;
    assert.ok(v.startsWith("/"), `every path in the plist is absolute: ${v}`);
  }
  assert.doesNotMatch(text, /\$\{|~\//, "no shell expansion, no tilde");
});

test("plistText escapes XML and refuses relative paths (node, cli, logs, state, ctx) and bad intervals", () => {
  const base = { node: NODE, cliPath: CLI, logDir: LOGS, stateDir: STATE, ctx: CTX_BIN };
  assert.match(plistText({ ...base, cliPath: "/Users/example/a&b/<cli>.mjs" }), /<string>\/Users\/example\/a&amp;b\/&lt;cli&gt;.mjs<\/string>/);
  assert.throws(() => plistText({ ...base, node: "node" }), /plist node must be an absolute path, got "node"/);
  assert.throws(() => plistText({ ...base, cliPath: "scripts/ctx-watch.mjs" }), /plist cliPath must be an absolute path/);
  assert.throws(() => plistText({ ...base, logDir: "logs" }), /plist logDir must be an absolute path/);
  assert.throws(() => plistText({ ...base, stateDir: undefined }), /plist stateDir must be an absolute path, got undefined/);
  assert.throws(() => plistText({ ...base, ctx: "ctx" }), /plist ctx must be an absolute path, got "ctx"/, "a bare name is a PATH lookup, which the plist must not have");
  assert.throws(() => plistText({ ...base, interval: 10 }), /interval must be a whole number of seconds, 30 or more, got 10/);
  assert.throws(() => plistText({ ...base, interval: NaN }), /interval must be/);
  assert.match(plistText(base), new RegExp(`<string>${DEFAULT_PATH}</string>`), "the default PATH when none is given");
});

test("dedupePath drops repeats, empties and relative entries, keeps order, falls back to the default", () => {
  assert.equal(dedupePath("/a:/b::/a:/c:/b"), "/a:/b:/c");
  assert.equal(dedupePath(".:relative/bin:/usr/bin:./x:../y"), "/usr/bin", "`.` and relative directories mean whatever launchd's cwd holds");
  assert.equal(dedupePath(".:relative/bin"), DEFAULT_PATH);
  assert.equal(dedupePath(""), DEFAULT_PATH);
  assert.equal(dedupePath(undefined), DEFAULT_PATH);
});

test("resolveCtx finds the first executable `ctx` on the absolute PATH entries only", () => {
  const files = new Set(["/opt/tools/ctx", "/usr/local/bin/ctx"]);
  const exists = (p) => files.has(p);
  assert.equal(resolveCtx("/usr/bin:/opt/tools:/usr/local/bin", { exists }), "/opt/tools/ctx");
  assert.equal(resolveCtx(".:relative/bin:/usr/local/bin", { exists }), "/usr/local/bin/ctx", "a `ctx` in `.` is never chosen");
  assert.equal(resolveCtx("/usr/bin:/bin", { exists }), null);
  assert.equal(resolveCtx(join(tmpdir(), "nothing-here-ctx-watch")), null, "the real check: no ctx in an empty directory");
});

test("shellQuote leaves plain paths alone and single-quotes spaces and metacharacters", () => {
  assert.equal(shellQuote("/Users/example/.local/state/ctx-watch/x.plist"), "/Users/example/.local/state/ctx-watch/x.plist");
  assert.equal(shellQuote("/Users/example/My Plugins/ctx-watch.mjs"), "'/Users/example/My Plugins/ctx-watch.mjs'");
  assert.equal(shellQuote("/tmp/a$b;rm -rf `x`"), "'/tmp/a$b;rm -rf `x`'");
  assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'");
});

/** A check double that records calls and answers per binary. */
function fakeCheck(answers) {
  const calls = [];
  const check = (bin, args) => {
    calls.push([bin, ...args]);
    return answers[bin] ?? { missing: true, code: null, output: "" };
  };
  return { calls, check };
}
const ctxAt = (...paths) => (p) => paths.includes(p);

test("install writes the plist under <state>/launchd with absolute paths, the state directory and the resolved ctx pinned, lints it, and prints the bootstrap line (never bootstraps)", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), PATH: ".:/Users/example/.local/bin:/usr/bin:/bin" };
    const { calls, check } = fakeCheck({ plutil: { missing: false, code: 0, output: `${plistPath(env)}: OK\n` }, launchctl: { missing: false, code: 113, output: "Could not find service" } });
    const r = install({ env, interval: 300, cliPath: "scripts/ctx-watch.mjs", cwd: "/Users/example/plugins/ctx-watch", node: NODE, uid: 501, check, exists: ctxAt("./ctx", CTX_BIN) });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.file, plistPath(env));
    assert.equal(r.ctx, CTX_BIN, "the `ctx` in `.` was skipped");
    const text = readFileSync(r.file, "utf8");
    assert.match(text, /<string>\/Users\/example\/plugins\/ctx-watch\/scripts\/ctx-watch.mjs<\/string>/, "a relative cliPath is resolved against cwd");
    assert.match(text, new RegExp(`<string>tick</string>\\s*<string>--state-dir</string>\\s*<string>${rx(join(root, "state", "ctx-watch"))}</string>\\s*<string>--ctx</string>\\s*<string>${CTX_BIN}</string>`), "the installing shell's state directory and ctx, as absolute paths");
    assert.match(text, /<key>PATH<\/key>\s*<string>\/Users\/example\/.local\/bin:\/usr\/bin:\/bin<\/string>/, "the relative PATH entry is gone");
    assert.match(text, /<integer>300<\/integer>/);
    assert.deepEqual(calls, [["plutil", "-lint", r.file], ["launchctl", "print", `gui/501/${LABEL}`]]);
    assert.match(r.text, new RegExp(`^wrote .*ctx-watch\\.plist \\(com\\.jo-wolff-plugins\\.ctx-watch, every 300 s, \`tick\`; ctx pinned at ${CTX_BIN}, state in ${rx(join(root, "state", "ctx-watch"))}\\)\nplutil -lint: OK\n`));
    assert.match(r.text, new RegExp(`launchd does not have ${LABEL}\\. To install it, run from your own Terminal[^\\n]*:\\n  launchctl bootstrap gui/501 ${rx(r.file)}\\n`));
    assert.match(r.text, /then check with:\n  node \/Users\/example\/plugins\/ctx-watch\/scripts\/ctx-watch.mjs status$/);
    assert.doesNotMatch(r.text, /bootout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: no ctx on PATH is exit 1 naming the PATH; --ctx pins a given executable (and must exist)", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), PATH: "/usr/bin:/bin" };
    const none = fakeCheck({});
    const r = install({ env, cliPath: CLI, node: NODE, uid: 501, check: none.check, exists: () => false });
    assert.equal(r.code, 1);
    assert.equal(r.text, "ctx-watch install: no executable `ctx` on PATH (/usr/bin:/bin); install ctx first (`ctx docs show getting-started`), or pass --ctx <absolute path>");
    assert.equal(none.calls.length, 0, "nothing linted, nothing written");
    const given = install({ env, cliPath: CLI, node: NODE, uid: 501, check: none.check, ctx: "/opt/ctx/bin/ctx", exists: ctxAt("/opt/ctx/bin/ctx") });
    assert.equal(given.code, 0, given.text);
    assert.equal(given.ctx, "/opt/ctx/bin/ctx");
    assert.match(readFileSync(given.file, "utf8"), /<string>--ctx<\/string>\s*<string>\/opt\/ctx\/bin\/ctx<\/string>/);
    const missing = install({ env, cliPath: CLI, node: NODE, uid: 501, check: none.check, ctx: "/opt/ctx/bin/ctx", exists: () => false });
    assert.equal(missing.code, 1);
    assert.equal(missing.text, "ctx-watch install: --ctx /opt/ctx/bin/ctx is not an executable file");
    const relative = install({ env, cliPath: CLI, node: NODE, uid: 501, check: none.check, cwd: "/opt/ctx", ctx: "bin/ctx", exists: ctxAt("/opt/ctx/bin/ctx") });
    assert.equal(relative.ctx, "/opt/ctx/bin/ctx", "a relative --ctx is resolved against cwd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: a loaded job gets the bootout-then-bootstrap line; a failed lint is exit 1; missing plutil/launchctl are said", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), PATH: "/usr/bin" };
    const exists = ctxAt("/usr/bin/ctx");
    const loadedJob = fakeCheck({ plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 0, output: `${LABEL} = {\n\tstate = waiting\n\tlast exit code = 0\n}` } });
    const r1 = install({ env, cliPath: CLI, node: NODE, uid: 501, check: loadedJob.check, exists });
    assert.equal(r1.code, 0);
    assert.match(r1.text, new RegExp(`launchd has ${LABEL} \\(state = waiting, last exit code = 0\\); to pick up this plist:\\n  launchctl bootout gui/501/${LABEL} && launchctl bootstrap gui/501 `));

    const badLint = fakeCheck({ plutil: { missing: false, code: 1, output: "x.plist: Unexpected character" } });
    const r2 = install({ env, cliPath: CLI, node: NODE, uid: 501, check: badLint.check, exists });
    assert.equal(r2.code, 1);
    assert.match(r2.text, /plutil -lint failed: x\.plist: Unexpected character$/);
    assert.equal(badLint.calls.length, 1, "no launchctl after a failed lint");

    const none = fakeCheck({});
    const r3 = install({ env, cliPath: CLI, node: NODE, uid: 501, check: none.check, exists });
    assert.equal(r3.code, 0);
    assert.match(r3.text, /plutil not found: the plist was not checked \(not macOS\?\)/);
    assert.match(r3.text, /launchctl not found: could not tell whether the job is loaded\. To install it/);

    const r4 = install({ env, cliPath: CLI, node: NODE, uid: 501, interval: 5, check: none.check, exists });
    assert.equal(r4.code, 1);
    assert.match(r4.text, /^ctx-watch install: interval must be/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: paths with spaces and metacharacters are one shell word each in the printed commands", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch launchd $x-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state dir"), PATH: "/usr/bin" };
    const { check } = fakeCheck({ plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 0, output: "state = waiting" } });
    const cli = "/Users/example/My Plugins/ctx-watch/scripts/ctx-watch.mjs";
    const r = install({ env, cliPath: cli, node: NODE, uid: 501, check, exists: ctxAt("/usr/bin/ctx") });
    assert.equal(r.code, 0, r.text);
    assert.ok(r.file.includes(" ") && r.file.includes("$"));
    assert.match(r.text, new RegExp(`launchctl bootout gui/501/${LABEL} && launchctl bootstrap gui/501 '${rx(r.file)}'$`));
    const r2 = install({ env, cliPath: cli, node: NODE, uid: 501, check: fakeCheck({ plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 113, output: "" } }).check, exists: ctxAt("/usr/bin/ctx") });
    assert.match(r2.text, new RegExp(`launchctl bootstrap gui/501 '${rx(r.file)}'\\nthen check with:\\n  node '${rx(cli)}' status$`));
    assert.match(readFileSync(r.file, "utf8"), new RegExp(`<string>${rx(cli)}</string>`), "the plist itself carries the path unquoted: launchd takes an array, not a shell line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loaded reads launchctl print; a refused launchctl (sandbox) is null, not false", () => {
  assert.deepEqual(loaded({ uid: 501, check: () => ({ missing: false, code: 0, output: "state = running\n" }) }), { loaded: true, detail: `launchd has ${LABEL} (state = running)` });
  assert.deepEqual(loaded({ uid: 501, check: () => ({ missing: false, code: 113, output: "" }) }), { loaded: false, detail: `launchd does not have ${LABEL}` });
  assert.deepEqual(loaded({ uid: 501, check: () => ({ missing: false, code: null, output: "spawn EPERM" }) }), { loaded: null, detail: "launchctl could not run: spawn EPERM" });
  assert.equal(loaded({ uid: 501, check: () => ({ missing: true, code: null, output: "" }) }).loaded, null);
});

test("uninstall prints the bootout line and removes nothing", () => {
  const env = { XDG_STATE_HOME: "/Users/example/s" };
  const r = uninstall({ env, uid: 501 });
  assert.equal(r.code, 0);
  assert.equal(r.text, `To stop the timer, run:\n  launchctl bootout gui/501/${LABEL}\nThe plist stays at ${plistPath(env)}; delete it yourself if you are done with it.`);
  assert.equal(uninstall({ env, uid: 501, stateDir: "/Volumes/x/ctx-watch" }).file, `/Volumes/x/ctx-watch/launchd/${LABEL}.plist`);
});

/** A child double: `{ child, emit }`; `pid` 42. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 42;
  return child;
}

test("popup: one osascript display dialog, quoted; delivered once the child outlives the grace; spawn injected", async () => {
  assert.equal(dialogScript({ text: 'say "hi" \\ there', giveUpSecs: 60 }), 'display dialog "say \\"hi\\" \\\\ there" with title "ctx-watch" buttons {"OK"} default button "OK" with icon caution giving up after 60');
  const calls = [];
  const r = await showPopup({ text: "ctx-watch: down", graceMs: 20, spawn: (bin, args) => (calls.push([bin, args]), fakeChild()) });
  assert.deepEqual(r, { started: true, detail: `popup started (${OSASCRIPT}, pid 42, gives up after ${GIVE_UP_SECS} s)` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.deepEqual(calls[0][1].slice(0, 1), ["-e"]);
  assert.match(calls[0][1][1], /^display dialog "ctx-watch: down" .* giving up after 3600$/);
  assert.equal(GRACE_MS, 1_000);
  const bad = await showPopup({ text: "x", spawn: () => { throw new Error("spawn EPERM"); } });
  assert.deepEqual(bad, { started: false, detail: "popup not shown: spawn EPERM" });
});

test("popup: an asynchronous spawn error, an early non-zero exit, and an early exit 0 are each the outcome, not a crash or a false start", async () => {
  const erroring = fakeChild();
  const p1 = showPopup({ text: "x", graceMs: 500, spawn: () => erroring });
  erroring.emit("error", Object.assign(new Error("spawn /usr/bin/osascript ENOENT"), { code: "ENOENT" }));
  assert.deepEqual(await p1, { started: false, detail: "popup not shown: spawn /usr/bin/osascript ENOENT" });

  const dying = fakeChild();
  const p2 = showPopup({ text: "x", graceMs: 500, spawn: () => dying });
  dying.emit("exit", 1, null);
  assert.deepEqual(await p2, { started: false, detail: `popup not shown: ${OSASCRIPT} ended with exit 1 within 500 ms` });

  const signalled = fakeChild();
  const p3 = showPopup({ text: "x", graceMs: 500, spawn: () => signalled });
  signalled.emit("exit", null, "SIGKILL");
  assert.deepEqual(await p3, { started: false, detail: `popup not shown: ${OSASCRIPT} ended by SIGKILL within 500 ms` });

  const quick = fakeChild();
  const p4 = showPopup({ text: "x", graceMs: 500, spawn: () => quick });
  quick.emit("exit", 0, null);
  assert.deepEqual(await p4, { started: true, detail: `popup shown (${OSASCRIPT}, pid 42, answered within 500 ms)` });

  const twice = fakeChild();
  const p5 = showPopup({ text: "x", graceMs: 20, spawn: () => twice });
  twice.emit("exit", 2, null);
  twice.emit("error", new Error("late"));
  assert.equal((await p5).started, false, "the first outcome wins; later events are ignored");
});

test("popup with real children (never osascript): a missing executable is `popup not shown` with ENOENT, a fast-failing one with its exit code", async () => {
  const t = Date.now();
  const missing = await showPopup({ text: "probe only; no dialog", bin: join(tmpdir(), "definitely-not-a-ctx-watch-executable"), graceMs: 2_000 });
  assert.equal(missing.started, false);
  assert.match(missing.detail, /^popup not shown: spawn .*definitely-not-a-ctx-watch-executable ENOENT$/);
  assert.ok(Date.now() - t < 2_000, "the error settles it before the grace");
  // `/bin/sh -e "display dialog …"`: sh takes `-e` as an option and the script as a file to run, which does not exist, and exits at once.
  const failing = await showPopup({ text: "probe only; no dialog", bin: "/bin/sh", graceMs: 2_000 });
  assert.equal(failing.started, false);
  assert.match(failing.detail, /^popup not shown: \/bin\/sh ended with exit [1-9]\d* within 2000 ms$/);
});
