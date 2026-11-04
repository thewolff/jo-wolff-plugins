// test/launchd.test.mjs — the plist (content, absolute paths, interval), install (write, lint,
// the bootstrap line; plutil and launchctl injected, never run), uninstall, loaded; and the
// popup's script and spawn (injected, never shown).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, DEFAULT_PATH, plistPath, plistText, install, uninstall, loaded, dedupePath } from "../lib/launchd.mjs";
import { dialogScript, showPopup, OSASCRIPT, GIVE_UP_SECS } from "../lib/popup.mjs";

const NODE = "/Users/example/.local/bin/node";
const CLI = "/Users/example/plugins/ctx-watch/scripts/ctx-watch.mjs";
const LOGS = "/Users/example/.local/state/ctx-watch/launchd";

test("plistPath is under <state>/launchd", () => {
  assert.equal(plistPath({ XDG_STATE_HOME: "/Users/example/s" }), `/Users/example/s/ctx-watch/launchd/${LABEL}.plist`);
  assert.equal(LABEL, "com.jo-wolff-plugins.ctx-watch");
});

test("plistText: label, `node <cli> tick`, StartInterval, RunAtLoad, logs beside the plist, PATH, no CI", () => {
  const text = plistText({ node: NODE, cliPath: CLI, interval: 300, logDir: LOGS, path: "/Users/example/.local/bin:/usr/bin:/bin" });
  assert.match(text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
  assert.match(text, new RegExp(`<key>ProgramArguments</key>\\s*<array>\\s*<string>${NODE}</string>\\s*<string>${CLI}</string>\\s*<string>tick</string>\\s*</array>`));
  assert.match(text, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, new RegExp(`<key>StandardOutPath</key>\\s*<string>${LOGS}/${LABEL}.out.log</string>`));
  assert.match(text, new RegExp(`<key>StandardErrorPath</key>\\s*<string>${LOGS}/${LABEL}.err.log</string>`));
  assert.match(text, /<key>PATH<\/key>\s*<string>\/Users\/example\/.local\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.doesNotMatch(text, /\bCI\b/);
  assert.doesNotMatch(text, /KeepAlive/, "a timer, not a kept-alive job");
  for (const s of text.matchAll(/<string>([^<]*)<\/string>/g)) {
    const v = s[1];
    if (v === LABEL || v === "tick" || v === "Background" || v.includes(":")) continue;
    assert.ok(v.startsWith("/"), `every path in the plist is absolute: ${v}`);
  }
  assert.doesNotMatch(text, /\$\{|~\//, "no shell expansion, no tilde");
});

test("plistText escapes XML and refuses relative paths and bad intervals", () => {
  assert.match(plistText({ node: NODE, cliPath: "/Users/example/a&b/<cli>.mjs", logDir: LOGS }), /<string>\/Users\/example\/a&amp;b\/&lt;cli&gt;.mjs<\/string>/);
  assert.throws(() => plistText({ node: "node", cliPath: CLI, logDir: LOGS }), /plist node must be an absolute path, got "node"/);
  assert.throws(() => plistText({ node: NODE, cliPath: "scripts/ctx-watch.mjs", logDir: LOGS }), /plist cliPath must be an absolute path/);
  assert.throws(() => plistText({ node: NODE, cliPath: CLI, logDir: "logs" }), /plist logDir must be an absolute path/);
  assert.throws(() => plistText({ node: NODE, cliPath: CLI, logDir: LOGS, interval: 10 }), /interval must be a whole number of seconds, 30 or more, got 10/);
  assert.throws(() => plistText({ node: NODE, cliPath: CLI, logDir: LOGS, interval: NaN }), /interval must be/);
  assert.match(plistText({ node: NODE, cliPath: CLI, logDir: LOGS }), new RegExp(`<string>${DEFAULT_PATH}</string>`), "the default PATH when none is given");
});

test("dedupePath drops repeats and empties, keeps order, falls back to the default", () => {
  assert.equal(dedupePath("/a:/b::/a:/c:/b"), "/a:/b:/c");
  assert.equal(dedupePath(""), DEFAULT_PATH);
  assert.equal(dedupePath(undefined), DEFAULT_PATH);
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

test("install writes the plist under <state>/launchd with absolute paths, lints it, and prints the bootstrap line (never bootstraps)", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), PATH: "/Users/example/.local/bin:/usr/bin:/bin" };
    const { calls, check } = fakeCheck({ plutil: { missing: false, code: 0, output: `${plistPath(env)}: OK\n` }, launchctl: { missing: false, code: 113, output: "Could not find service" } });
    const r = install({ env, interval: 300, cliPath: "scripts/ctx-watch.mjs", cwd: "/Users/example/plugins/ctx-watch", node: NODE, uid: 501, check });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.file, plistPath(env));
    const text = readFileSync(r.file, "utf8");
    assert.match(text, /<string>\/Users\/example\/plugins\/ctx-watch\/scripts\/ctx-watch.mjs<\/string>/, "a relative cliPath is resolved against cwd");
    assert.match(text, /<integer>300<\/integer>/);
    assert.deepEqual(calls, [["plutil", "-lint", r.file], ["launchctl", "print", `gui/501/${LABEL}`]]);
    assert.match(r.text, /^wrote .*ctx-watch\.plist \(com\.jo-wolff-plugins\.ctx-watch, every 300 s, `tick`\)\nplutil -lint: OK\n/);
    assert.match(r.text, new RegExp(`launchd does not have ${LABEL}\\. To install it, run from your own Terminal[^\\n]*:\\n  launchctl bootstrap gui/501 ${r.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(r.text, /then check with:\n  node \/Users\/example\/plugins\/ctx-watch\/scripts\/ctx-watch.mjs status$/);
    assert.doesNotMatch(r.text, /bootout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: a loaded job gets the bootout-then-bootstrap line; a failed lint is exit 1; missing plutil/launchctl are said", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), PATH: "/usr/bin" };
    const loadedJob = fakeCheck({ plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 0, output: `${LABEL} = {\n\tstate = waiting\n\tlast exit code = 0\n}` } });
    const r1 = install({ env, cliPath: CLI, node: NODE, uid: 501, check: loadedJob.check });
    assert.equal(r1.code, 0);
    assert.match(r1.text, new RegExp(`launchd has ${LABEL} \\(state = waiting, last exit code = 0\\); to pick up this plist:\\n  launchctl bootout gui/501/${LABEL} && launchctl bootstrap gui/501 `));

    const badLint = fakeCheck({ plutil: { missing: false, code: 1, output: "x.plist: Unexpected character" } });
    const r2 = install({ env, cliPath: CLI, node: NODE, uid: 501, check: badLint.check });
    assert.equal(r2.code, 1);
    assert.match(r2.text, /plutil -lint failed: x\.plist: Unexpected character$/);
    assert.equal(badLint.calls.length, 1, "no launchctl after a failed lint");

    const none = fakeCheck({});
    const r3 = install({ env, cliPath: CLI, node: NODE, uid: 501, check: none.check });
    assert.equal(r3.code, 0);
    assert.match(r3.text, /plutil not found: the plist was not checked \(not macOS\?\)/);
    assert.match(r3.text, /launchctl not found: could not tell whether the job is loaded\. To install it/);

    const r4 = install({ env, cliPath: CLI, node: NODE, uid: 501, interval: 5, check: none.check });
    assert.equal(r4.code, 1);
    assert.match(r4.text, /^ctx-watch install: interval must be/);
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
});

test("popup: one osascript display dialog, quoted, giving up after the bound; spawn injected", () => {
  assert.equal(dialogScript({ text: 'say "hi" \\ there', giveUpSecs: 60 }), 'display dialog "say \\"hi\\" \\\\ there" with title "ctx-watch" buttons {"OK"} default button "OK" with icon caution giving up after 60');
  const calls = [];
  const r = showPopup({ text: "ctx-watch: down", spawn: (bin, args) => (calls.push([bin, args]), { pid: 42 }) });
  assert.deepEqual(r, { started: true, detail: `popup started (${OSASCRIPT}, pid 42, gives up after ${GIVE_UP_SECS} s)` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.deepEqual(calls[0][1].slice(0, 1), ["-e"]);
  assert.match(calls[0][1][1], /^display dialog "ctx-watch: down" .* giving up after 3600$/);
  const bad = showPopup({ text: "x", spawn: () => { throw new Error("spawn EPERM"); } });
  assert.deepEqual(bad, { started: false, detail: "popup not shown: spawn EPERM" });
});
