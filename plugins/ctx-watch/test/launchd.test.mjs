// test/launchd.test.mjs — the plist (content, absolute paths, the pinned state directory and
// ctx, interval), install (write, lint, the bootstrap line with its paths shell-quoted; plutil
// and launchctl injected, never run; ctx resolved through an injected `exists`), uninstall,
// loaded; and the popup's script and delivery (a spawn double for the lifecycle, a real
// supervisor over children that are not osascript for the error, early-exit and late-exit
// paths; never a dialog).

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LABEL, DEFAULT_PATH, plistPath, legacyPlistPath, plistText, install, uninstall, loaded, timerHealth, dedupePath, resolveCtx, shellQuote, untrustedReason } from "../lib/launchd.mjs";
import { dialogScript, showPopup, readOutcome, outcomePath, OSASCRIPT, GIVE_UP_SECS, GRACE_MS, SUPERVISOR } from "../lib/popup.mjs";
import { INTERVAL_BOUNDS } from "../lib/state.mjs";

const NODE = "/Users/example/.local/bin/node";
const CLI = "/Users/example/plugins/ctx-watch/scripts/ctx-watch.mjs";
const LOGS = "/Users/example/.local/state/ctx-watch/launchd";
const STATE = "/Users/example/.local/state/ctx-watch";
const CTX_BIN = "/Users/example/.local/bin/ctx";
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The trust check for tests whose node, CLI and ctx paths are made up: every path is trusted. The real check has its own tests. */
const TRUST_ALL = () => null;
/** `<root>/home`, created: install refuses a HOME that does not exist. */
const homeIn = (root) => (mkdirSync(join(root, "home"), { recursive: true }), join(root, "home"));

test("0.4.3 plistPath is $HOME/Library/LaunchAgents (what login loads); legacyPlistPath is the pre-0.4.3 <state>/launchd", () => {
  assert.equal(plistPath({ HOME: "/Users/example", XDG_STATE_HOME: "/Users/example/s" }), `/Users/example/Library/LaunchAgents/${LABEL}.plist`);
  assert.equal(legacyPlistPath({ XDG_STATE_HOME: "/Users/example/s" }), `/Users/example/s/ctx-watch/launchd/${LABEL}.plist`);
  assert.equal(legacyPlistPath({ XDG_STATE_HOME: "/Users/example/s" }, LABEL, "/Volumes/x/ctx-watch"), `/Volumes/x/ctx-watch/launchd/${LABEL}.plist`);
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
  assert.throws(() => plistText({ ...base, interval: 10 }), /interval must be a whole number of seconds, 30\.\.604800, got 10/);
  assert.throws(() => plistText({ ...base, interval: NaN }), /interval must be/);
  assert.throws(() => plistText({ ...base, interval: INTERVAL_BOUNDS.max + 1 }), /interval must be a whole number of seconds, 30\.\.604800, got 604801/, "the state file could not hold it");
  assert.match(plistText({ ...base, interval: INTERVAL_BOUNDS.max }), /<integer>604800<\/integer>/);
  assert.match(plistText({ ...base, interval: INTERVAL_BOUNDS.min }), /<integer>30<\/integer>/);
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

test("0.4.3 install writes the plist to $HOME/Library/LaunchAgents with logs under <state>/launchd, absolute paths, the state directory and the resolved ctx pinned, lints it, and prints the bootstrap line naming that path (never bootstraps)", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), HOME: homeIn(root), PATH: ".:/Users/example/.local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8" };
    const { calls, check } = fakeCheck({ plutil: { missing: false, code: 0, output: `${plistPath(env)}: OK\n` }, launchctl: { missing: false, code: 113, output: "Could not find service" } });
    const r = install({ trust: TRUST_ALL, env, interval: 300, cliPath: "scripts/ctx-watch.mjs", cwd: "/Users/example/plugins/ctx-watch", node: NODE, uid: 501, check, exists: ctxAt("./ctx", CTX_BIN) });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.file, join(root, "home", "Library", "LaunchAgents", `${LABEL}.plist`));
    assert.equal(r.migrated, null, "no old plist, nothing moved");
    assert.equal(existsSync(legacyPlistPath(env)), false, "nothing written at the old path");
    assert.equal(r.ctx, CTX_BIN, "the `ctx` in `.` was skipped");
    const text = readFileSync(r.file, "utf8");
    assert.match(text, /<string>\/Users\/example\/plugins\/ctx-watch\/scripts\/ctx-watch.mjs<\/string>/, "a relative cliPath is resolved against cwd");
    assert.match(text, new RegExp(`<string>tick</string>\\s*<string>--state-dir</string>\\s*<string>${rx(join(root, "state", "ctx-watch"))}</string>\\s*<string>--ctx</string>\\s*<string>${CTX_BIN}</string>`), "the installing shell's state directory and ctx, as absolute paths");
    assert.match(text, new RegExp(`<key>StandardOutPath</key>\\s*<string>${rx(join(root, "state", "ctx-watch", "launchd", `${LABEL}.out.log`))}</string>`), "logs stay in the state directory");
    assert.match(text, /<key>PATH<\/key>\s*<string>\/Users\/example\/.local\/bin:\/usr\/bin:\/bin<\/string>/, "the relative PATH entry is gone");
    assert.match(text, /<integer>300<\/integer>/);
    assert.deepEqual(calls, [["plutil", "-lint", r.file], ["launchctl", "print", `gui/501/${LABEL}`]]);
    assert.match(r.text, new RegExp(`^wrote ${rx(r.file)} \\(com\\.jo-wolff-plugins\\.ctx-watch, every 300 s, \`tick\`; ctx pinned at ${CTX_BIN}, state in ${rx(join(root, "state", "ctx-watch"))}, logs in ${rx(join(root, "state", "ctx-watch", "launchd"))}\\)\nenvironment: PATH, LANG\nplutil -lint: OK\n`));
    assert.match(r.text, new RegExp(`launchd does not have ${LABEL}\\. To install it, run from your own Terminal[^\\n]*:\\n  launchctl bootstrap gui/501 ${rx(r.file)}\\n`));
    assert.match(r.text, /then check with:\n  node \/Users\/example\/plugins\/ctx-watch\/scripts\/ctx-watch.mjs status$/);
    assert.doesNotMatch(r.text, /bootout|moved/);

    const noHome = install({ trust: TRUST_ALL, env: { ...env, HOME: undefined }, cliPath: CLI, node: NODE, uid: 501, check, exists: ctxAt(CTX_BIN) });
    assert.equal(noHome.code, 1);
    assert.match(noHome.text, /^ctx-watch install: HOME is not set to an absolute path \(null\): the plist goes in \$HOME\/Library\/LaunchAgents$/, "never another HOME's LaunchAgents");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0.4.3 install over a pre-0.4.3 plist: the old file is removed after the new one lints, install says so, and prints the bootout + bootstrap pair", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  const old = (env) => {
    mkdirSync(dirname(legacyPlistPath(env)), { recursive: true });
    writeFileSync(legacyPlistPath(env), "<plist/>");
  };
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), HOME: homeIn(root), PATH: "/usr/bin", LANG: "en_US.UTF-8" };
    const exists = ctxAt("/usr/bin/ctx");
    const lint = { missing: false, code: 0, output: "OK" };
    const file = plistPath(env);
    const pair = `launchctl bootout gui/501/${LABEL} && launchctl bootstrap gui/501 ${file}`;
    const moved = `moved the plist from ${legacyPlistPath(env)} (removed) to ${file}: launchd loads a person's LaunchAgents only from ~/Library/LaunchAgents at login, so a job loaded from the old path was gone after a reboot.`;

    // Loaded from the old path (the 0.4.2 state on a machine not yet rebooted): `&&` pair.
    old(env);
    const r1 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck({ plutil: lint, launchctl: { missing: false, code: 0, output: `\tpath = ${legacyPlistPath(env)}\n\tstate = waiting\n` } }).check, exists });
    assert.equal(r1.code, 0, r1.text);
    assert.equal(r1.migrated, legacyPlistPath(env));
    assert.equal(existsSync(legacyPlistPath(env)), false, "the old plist is gone");
    assert.ok(existsSync(file), "the new one is in LaunchAgents");
    assert.ok(r1.text.includes(`\n${moved}\n`), r1.text);
    assert.ok(r1.text.endsWith(`(the loaded job still runs from the old one):\n  ${pair}`), r1.text);

    // After a reboot: launchd does not have it, so there is nothing to boot out.
    old(env);
    const r2 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck({ plutil: lint, launchctl: { missing: false, code: 113, output: "" } }).check, exists });
    assert.ok(r2.text.includes(moved));
    assert.match(r2.text, new RegExp(`launchd does not have ${LABEL}\\. To install it, [^\\n]*:\\n  launchctl bootstrap gui/501 ${rx(file)}\\n`));
    assert.doesNotMatch(r2.text, /bootout/);

    // launchctl could not say (a sandbox): the pair with `;`, so a bootout that finds nothing does not stop the bootstrap.
    old(env);
    const r3 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck({ plutil: lint, launchctl: { missing: false, code: null, output: "spawn EPERM" } }).check, exists });
    assert.ok(r3.text.includes(moved));
    assert.ok(r3.text.includes(`\n  launchctl bootout gui/501/${LABEL}; launchctl bootstrap gui/501 ${file}\n`), r3.text);

    // A failed lint keeps the old plist: the new one is not known good.
    old(env);
    const r4 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck({ plutil: { missing: false, code: 1, output: "bad" } }).check, exists });
    assert.equal(r4.code, 1);
    assert.ok(existsSync(legacyPlistPath(env)), "kept after a failed lint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A temp root with a created HOME and the env install reads; `release` removes it. */
function installBox() {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  const env = { XDG_STATE_HOME: join(root, "state"), HOME: homeIn(root), PATH: "/usr/bin", LANG: "en_US.UTF-8" };
  return { root, env, release: () => rmSync(root, { recursive: true, force: true }) };
}
const LINT_OK = { plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 113, output: "" } };
const ME = process.getuid?.() ?? 501;
/** A stat result for `p` with `fields` overridden (methods such as isFile still work). */
const statWith = (s, fields) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, fields);
/** An lstat that reports `uid` as the owner of `target` and is real for everything else. */
const ownedBy = (target, uid) => (p) => (p === target ? statWith(lstatSync(p), { uid }) : lstatSync(p));

test("0.4.3 install refuses a symlinked LaunchAgents directory or plist, and changes nothing through either", () => {
  const b = installBox();
  try {
    const elsewhere = join(b.root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(b.env.HOME, "Library"));
    symlinkSync(elsewhere, join(b.env.HOME, "Library", "LaunchAgents"));
    const r = install({ trust: TRUST_ALL, env: b.env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck(LINT_OK).check, exists: ctxAt("/usr/bin/ctx") });
    assert.equal(r.code, 1);
    assert.equal(r.text, `ctx-watch install: ${join(b.env.HOME, "Library", "LaunchAgents")} is a symlink; refusing to write a login-loaded plist through it`);
    assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");

    unlinkSync(join(b.env.HOME, "Library", "LaunchAgents"));
    mkdirSync(join(b.env.HOME, "Library", "LaunchAgents"));
    const victim = join(b.root, "victim.txt");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, plistPath(b.env));
    const r2 = install({ trust: TRUST_ALL, env: b.env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck(LINT_OK).check, exists: ctxAt("/usr/bin/ctx") });
    assert.equal(r2.code, 1);
    assert.equal(r2.text, `ctx-watch install: ${plistPath(b.env)} is a symlink; refusing to replace it`);
    assert.equal(readFileSync(victim, "utf8"), "keep me", "the link's target is untouched");
    assert.ok(lstatSync(plistPath(b.env)).isSymbolicLink(), "and the link is still a link");
    assert.deepEqual(readdirSync(join(b.env.HOME, "Library", "LaunchAgents")), [`${LABEL}.plist`], "no temporary file left");
  } finally {
    b.release();
  }
});

test("0.4.3 install refuses a LaunchAgents directory or plist owned by someone else, or a directory others can write, and changes nothing", () => {
  const b = installBox();
  try {
    const agents = join(b.env.HOME, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    chmodSync(join(b.env.HOME, "Library"), 0o755);
    chmodSync(agents, 0o755);
    writeFileSync(plistPath(b.env), "theirs");
    const base = { trust: TRUST_ALL, env: b.env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck(LINT_OK).check, exists: ctxAt("/usr/bin/ctx"), owner: ME };

    const foreignDir = install({ ...base, lstat: ownedBy(agents, ME + 1) });
    assert.equal(foreignDir.code, 1);
    assert.equal(foreignDir.text, `ctx-watch install: ${agents} is owned by uid ${ME + 1}, not you (${ME}); launchd will not load your agents from it`);
    const foreignFile = install({ ...base, lstat: ownedBy(plistPath(b.env), ME + 1) });
    assert.equal(foreignFile.code, 1);
    assert.equal(foreignFile.text, `ctx-watch install: ${plistPath(b.env)} is owned by uid ${ME + 1}, not you (${ME}); refusing to replace it`);
    assert.equal(readFileSync(plistPath(b.env), "utf8"), "theirs", "a refused plist is not truncated");

    chmodSync(agents, 0o775);
    const groupWritable = install(base);
    assert.equal(groupWritable.code, 1);
    assert.equal(groupWritable.text, `ctx-watch install: ${agents} is writable by group or others (mode 775); launchd will not load your agents from it`);
    assert.equal(statSync(agents).mode & 0o777, 0o775, "install does not chmod a directory it did not create");
    assert.equal(readFileSync(plistPath(b.env), "utf8"), "theirs");
    assert.deepEqual(readdirSync(agents), [`${LABEL}.plist`], "no temporary file left");
  } finally {
    b.release();
  }
});

test("0.4.3 install under a permissive umask still creates ~/Library/LaunchAgents 0755 and the plist 0644, owned by the installing user", () => {
  const b = installBox();
  const old = process.umask(0);
  try {
    const r = install({ trust: TRUST_ALL, env: b.env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck(LINT_OK).check, exists: ctxAt("/usr/bin/ctx") });
    assert.equal(r.code, 0, r.text);
    assert.equal(statSync(join(b.env.HOME, "Library")).mode & 0o777, 0o755);
    assert.equal(statSync(join(b.env.HOME, "Library", "LaunchAgents")).mode & 0o777, 0o755);
    const s = lstatSync(r.file);
    assert.ok(s.isFile());
    assert.equal(s.mode & 0o777, 0o644);
    assert.equal(s.uid, ME);
    assert.deepEqual(readdirSync(join(b.env.HOME, "Library", "LaunchAgents")), [`${LABEL}.plist`], "the temporary file was renamed, not left");
  } finally {
    process.umask(old);
    b.release();
  }
});

test("0.4.3 install keeps the pre-0.4.3 plist when plutil is missing: no lint, no removal, and it says the move is not finished", () => {
  const b = installBox();
  try {
    const legacy = legacyPlistPath(b.env);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "<plist>old</plist>");
    const r = install({ trust: TRUST_ALL, env: b.env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck({ launchctl: { missing: false, code: 0, output: "state = running" } }).check, exists: ctxAt("/usr/bin/ctx") });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.migrated, null, "no successful migration claimed");
    assert.equal(readFileSync(legacy, "utf8"), "<plist>old</plist>", "the old plist is intact");
    assert.ok(r.text.includes(`\nplutil not found: the plist was not checked (not macOS?)\nkept the old plist at ${legacy}: the new one was not checked, so the move is not finished.`), r.text);
    assert.doesNotMatch(r.text, /moved the plist/);
  } finally {
    b.release();
  }
});

test("0.4.3 install prints the command from launchctl's answer, not from whether this run moved a file: a repeated install and a failed removal under an unknown state still get the bootout ; bootstrap pair", () => {
  const b = installBox();
  try {
    const legacy = legacyPlistPath(b.env);
    const unknown = { plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: null, output: "spawn EPERM" } };
    const pair = `\n  launchctl bootout gui/501/${LABEL}; launchctl bootstrap gui/501 ${plistPath(b.env)}\n`;
    const run = () => install({ trust: TRUST_ALL, env: b.env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck(unknown).check, exists: ctxAt("/usr/bin/ctx") });

    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "<plist/>");
    const first = run();
    assert.equal(first.migrated, legacy);
    assert.ok(first.text.includes(pair), first.text);
    const second = run();
    assert.equal(second.migrated, null, "nothing left to move");
    assert.ok(second.text.includes(pair), `the second install still offers the pair: ${second.text}`);

    mkdirSync(join(legacy, "in-the-way"), { recursive: true });
    const stuck = run();
    assert.equal(stuck.migrated, null);
    assert.match(stuck.text, new RegExp(`the old plist at ${rx(legacy)} could not be removed`));
    assert.ok(stuck.text.includes(pair), stuck.text);

    const absent = install({ trust: TRUST_ALL, env: b.env, cliPath: CLI, node: NODE, uid: 501, check: fakeCheck(LINT_OK).check, exists: ctxAt("/usr/bin/ctx") });
    assert.ok(absent.text.includes(`\n  launchctl bootstrap gui/501 ${plistPath(b.env)}\n`));
    assert.doesNotMatch(absent.text, /launchctl bootout/, "known not loaded: the bootstrap alone");
  } finally {
    b.release();
  }
});

test("0.4.3 untrustedReason: an executable, its real target, and every directory above both must be yours or root's and writable by no one else", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-trust-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    chmodSync(root, 0o755);
    chmodSync(bin, 0o755);
    const tool = join(bin, "node");
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o755);
    assert.equal(untrustedReason(tool), null, "a 0755 file of yours in 0755 directories of yours");
    const real = realpathSync(tool);
    const named = real === tool ? tool : `${tool} (real path ${real})`; // macOS: /var is /private/var

    chmodSync(tool, 0o777);
    assert.equal(untrustedReason(tool), `${named} is writable by every user`);
    chmodSync(tool, 0o775);
    const gid = (g) => (p) => (p === real ? statWith(statSync(p), { gid: g }) : statSync(p));
    assert.equal(untrustedReason(tool, { stat: gid(20) }), `${named} is writable by group 20`);
    assert.equal(untrustedReason(tool, { stat: gid(80) }), null, "group admin: its members can already act as root");
    chmodSync(tool, 0o755);

    chmodSync(bin, 0o777);
    assert.equal(untrustedReason(tool), `${bin} (above ${tool}) is writable by every user`, "a safe file in an unsafe directory");
    chmodSync(bin, 0o755);

    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const link = join(open, "node");
    symlinkSync(tool, link);
    assert.equal(untrustedReason(link), `${open} (above ${link}) is writable by every user`, "a symlink anyone can swap, to a safe target");

    assert.equal(untrustedReason(tool, { owner: ME + 1 }), `${bin} (above ${tool}) is owned by uid ${ME}, not you (${ME + 1}) or root`);
    assert.match(untrustedReason(join(bin, "absent")), /cannot be resolved \(ENOENT\)$/);

    // Wired into install: refused before anything is written.
    const env = { XDG_STATE_HOME: join(root, "state"), HOME: homeIn(root), PATH: "/usr/bin", LANG: "en_US.UTF-8" };
    chmodSync(tool, 0o777);
    const r = install({ env, cliPath: tool, node: tool, uid: 501, check: fakeCheck(LINT_OK).check, ctx: tool });
    assert.equal(r.code, 1);
    assert.equal(r.text, `ctx-watch install: node at ${tool} is not safe for a login job to run: ${named} is writable by every user`);
    assert.equal(existsSync(join(env.HOME, "Library")), false, "nothing written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: no ctx on PATH is exit 1 naming the PATH; --ctx pins a given executable (and must exist)", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), HOME: homeIn(root), PATH: "/usr/bin:/bin" };
    const none = fakeCheck({});
    const r = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: none.check, exists: () => false });
    assert.equal(r.code, 1);
    assert.equal(r.text, "ctx-watch install: no executable `ctx` on PATH (/usr/bin:/bin); install ctx first (`ctx docs show getting-started`), or pass --ctx <absolute path>");
    assert.equal(none.calls.length, 0, "nothing linted, nothing written");
    const given = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: none.check, ctx: "/opt/ctx/bin/ctx", exists: ctxAt("/opt/ctx/bin/ctx") });
    assert.equal(given.code, 0, given.text);
    assert.equal(given.ctx, "/opt/ctx/bin/ctx");
    assert.match(readFileSync(given.file, "utf8"), /<string>--ctx<\/string>\s*<string>\/opt\/ctx\/bin\/ctx<\/string>/);
    const missing = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: none.check, ctx: "/opt/ctx/bin/ctx", exists: () => false });
    assert.equal(missing.code, 1);
    assert.equal(missing.text, "ctx-watch install: --ctx /opt/ctx/bin/ctx is not an executable file");
    const relative = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: none.check, cwd: "/opt/ctx", ctx: "bin/ctx", exists: ctxAt("/opt/ctx/bin/ctx") });
    assert.equal(relative.ctx, "/opt/ctx/bin/ctx", "a relative --ctx is resolved against cwd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: a loaded job gets the bootout-then-bootstrap line; a failed lint is exit 1; missing plutil/launchctl are said", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch-launchd-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state"), HOME: homeIn(root), PATH: "/usr/bin" };
    const exists = ctxAt("/usr/bin/ctx");
    const loadedJob = fakeCheck({ plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 0, output: `${LABEL} = {\n\tstate = waiting\n\tlast exit code = 0\n}` } });
    const r1 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: loadedJob.check, exists });
    assert.equal(r1.code, 0);
    assert.match(r1.text, new RegExp(`launchd has ${LABEL} \\(state = waiting, last exit code = 0\\); to pick up this plist:\\n  launchctl bootout gui/501/${LABEL} && launchctl bootstrap gui/501 `));

    const badLint = fakeCheck({ plutil: { missing: false, code: 1, output: "x.plist: Unexpected character" } });
    const r2 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: badLint.check, exists });
    assert.equal(r2.code, 1);
    assert.match(r2.text, /plutil -lint failed: x\.plist: Unexpected character$/);
    assert.deepEqual(badLint.calls.filter(([bin]) => bin === "launchctl"), [], "no launchctl after a failed lint");

    const none = fakeCheck({});
    const r3 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, check: none.check, exists });
    assert.equal(r3.code, 0);
    assert.match(r3.text, /plutil not found: the plist was not checked \(not macOS\?\)/);
    assert.ok(r3.text.includes(`launchctl not found: could not tell whether the job is loaded. To load this plist whether or not a job is loaded now, run from your own Terminal (a GUI login, not an agent shell; the bootout may answer "No such process" when nothing is loaded):\n  launchctl bootout gui/501/${LABEL}; launchctl bootstrap gui/501 ${plistPath(env)}\n`), r3.text);

    const r4 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, interval: 5, check: none.check, exists });
    assert.equal(r4.code, 1);
    assert.match(r4.text, /^ctx-watch install: interval must be/);
    const fresh = join(root, "fresh");
    const r5 = install({ trust: TRUST_ALL, env, cliPath: CLI, node: NODE, uid: 501, interval: 604_801, check: none.check, exists, stateDir: fresh });
    assert.equal(r5.code, 1);
    assert.match(r5.text, /^ctx-watch install: interval must be a whole number of seconds, 30\.\.604800, got 604801/);
    assert.equal(existsSync(fresh), false, "refused before any artifact is written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: paths with spaces and metacharacters are one shell word each in the printed commands", () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-watch launchd $x-"));
  try {
    const env = { XDG_STATE_HOME: join(root, "state dir"), HOME: homeIn(root), PATH: "/usr/bin" };
    const { check } = fakeCheck({ plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 0, output: "state = waiting" } });
    const cli = "/Users/example/My Plugins/ctx-watch/scripts/ctx-watch.mjs";
    const r = install({ trust: TRUST_ALL, env, cliPath: cli, node: NODE, uid: 501, check, exists: ctxAt("/usr/bin/ctx") });
    assert.equal(r.code, 0, r.text);
    assert.ok(r.file.includes(" ") && r.file.includes("$"));
    assert.match(r.text, new RegExp(`launchctl bootout gui/501/${LABEL} && launchctl bootstrap gui/501 '${rx(r.file)}'$`));
    const r2 = install({ trust: TRUST_ALL, env, cliPath: cli, node: NODE, uid: 501, check: fakeCheck({ plutil: { missing: false, code: 0, output: "OK" }, launchctl: { missing: false, code: 113, output: "" } }).check, exists: ctxAt("/usr/bin/ctx") });
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

/** The shape of a real `launchctl print gui/501/<label>` (Darwin 25.6, 2026-11-16), trimmed, paths replaced. */
const PRINT = (plist, script) => `gui/501/${LABEL} = {\n\tactive count = 0\n\tpath = ${plist}\n\ttype = LaunchAgent\n\tstate = not running\n\n\tprogram = ${NODE}\n\targuments = {\n\t\t${NODE}\n\t\t${script}\n\t\ttick\n\t\t--state-dir\n\t\t${STATE}\n\t}\n\n\tstdout path = ${LOGS}/${LABEL}.out.log\n\tlast exit code = 0\n}\n`;

test("0.4.3 loaded also returns the job's plist path and arguments when launchctl print shows them", () => {
  const l = loaded({ uid: 501, check: () => ({ missing: false, code: 0, output: PRINT("/Users/example/Library/LaunchAgents/x.plist", CLI) }) });
  assert.equal(l.loaded, true);
  assert.equal(l.detail, `launchd has ${LABEL} (state = not running, last exit code = 0)`, "a two-word state is not cut at its space");
  assert.equal(l.plist, "/Users/example/Library/LaunchAgents/x.plist", "`path =`, not `stdout path =`");
  assert.deepEqual(l.args, [NODE, CLI, "tick", "--state-dir", STATE]);
});

test("0.4.3 timerHealth: nothing installed asks launchd nothing; 113 is not-loaded; a loaded job's missing script is script-missing; a timeout or refusal is no answer", () => {
  const env = { HOME: "/Users/example", XDG_STATE_HOME: "/Users/example/.local/state" };
  const agent = plistPath(env);
  const legacy = legacyPlistPath(env);
  const files = (...present) => (p) => present.includes(p);
  const calls = [];
  const lc = (answer) => (bin, args) => (calls.push([bin, ...args]), answer);

  const none = timerHealth({ env, uid: 501, check: lc({ missing: false, code: 113, output: "" }), exists: files() });
  assert.equal(none.ok, null);
  assert.deepEqual(calls, [], "no plist anywhere: launchctl is not asked");

  const gone = timerHealth({ env, uid: 501, check: lc({ missing: false, code: 113, output: "Could not find service" }), exists: files(agent) });
  assert.deepEqual({ ok: gone.ok, kind: gone.kind, reason: gone.reason }, { ok: false, kind: "not-loaded", reason: "timer not in launchd gui/501" });
  assert.deepEqual(calls.at(-1), ["launchctl", "print", `gui/501/${LABEL}`]);
  const goneOld = timerHealth({ env, uid: 501, check: lc({ missing: false, code: 113, output: "" }), exists: files(legacy) });
  assert.equal(goneOld.kind, "not-loaded");
  assert.match(goneOld.detail, /outside ~\/Library\/LaunchAgents, so login does not load it/);

  const stale = timerHealth({ env, uid: 501, check: lc({ missing: false, code: 0, output: PRINT(agent, "/Users/example/.claude/plugins/cache/x/ctx-watch/0.4.1/scripts/ctx-watch.mjs") }), exists: files(agent) });
  assert.deepEqual({ ok: stale.ok, kind: stale.kind, reason: stale.reason }, { ok: false, kind: "script-missing", reason: "timer's script no longer exists" });
  assert.match(stale.detail, /0\.4\.1\/scripts\/ctx-watch\.mjs, which does not exist$/);

  assert.equal(timerHealth({ env, uid: 501, check: lc({ missing: false, code: 0, output: PRINT(agent, CLI) }), exists: files(agent, CLI) }).ok, true);
  for (const answer of [{ missing: false, code: null, output: "spawnSync launchctl ETIMEDOUT" }, { missing: false, code: 5, output: "Input/output error" }, { missing: true, code: null, output: "" }]) {
    assert.equal(timerHealth({ env, uid: 501, check: lc(answer), exists: files(agent) }).ok, null, `no answer is not "not loaded": ${JSON.stringify(answer)}`);
  }
});

test("uninstall prints the bootout line and the rm that keeps login from loading it again, and removes nothing", () => {
  const env = { HOME: "/Users/example", XDG_STATE_HOME: "/Users/example/s" };
  const r = uninstall({ env, uid: 501 });
  assert.equal(r.code, 0);
  assert.equal(r.text, `To stop the timer, run:\n  launchctl bootout gui/501/${LABEL}\nThe plist stays at /Users/example/Library/LaunchAgents/${LABEL}.plist, and launchd loads it again at your next login; to stop that too, delete it:\n  rm /Users/example/Library/LaunchAgents/${LABEL}.plist`);
  assert.equal(r.file, plistPath(env));
});

/** A child double: `{ child, emit }`; `pid` 42. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 42;
  return child;
}

/** An outcome file nobody writes: a fake supervisor never records one. */
const NOWHERE = join(tmpdir(), "ctx-watch-no-such-dir", "popup.json");

/** Poll `file` until it holds `token`'s outcome (the detached supervisor writes it after the child ends). */
async function waitForOutcome(file, token, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const o = readOutcome(file);
    if (o?.token === token) return o;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`no outcome for ${token} in ${file} within ${ms} ms`);
}

/** A stand-in for osascript: sleeps `secs`, then exits `code` (never a dialog). */
function fakeOsascript(dir, secs, code) {
  const p = join(dir, `osascript-${code}`);
  writeFileSync(p, `#!/bin/sh\n/bin/sleep ${secs}\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("popup: one osascript display dialog, quoted, run under the supervisor; still running after the grace is pending, not delivered; spawn injected", async () => {
  assert.equal(dialogScript({ text: 'say "hi" \\ there', giveUpSecs: 60 }), 'display dialog "say \\"hi\\" \\\\ there" with title "ctx-watch" buttons {"OK"} default button "OK" with icon caution giving up after 60');
  const calls = [];
  const r = await showPopup({ text: "ctx-watch: down", graceMs: 20, outcomeFile: NOWHERE, token: "t1", spawn: (bin, args) => (calls.push([bin, args]), fakeChild()) });
  assert.deepEqual(r, { started: true, pending: true, token: "t1", detail: `popup started (${OSASCRIPT} under supervisor pid 42, gives up after ${GIVE_UP_SECS} s); delivered once it exits 0` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath, "node runs the supervisor");
  assert.deepEqual(calls[0][1].slice(0, 5), [SUPERVISOR, NOWHERE, "t1", OSASCRIPT, "-e"]);
  assert.match(calls[0][1][5], /^display dialog "ctx-watch: down" .* giving up after 3600$/);
  assert.equal(calls[0][1].length, 6);
  assert.equal(GRACE_MS, 1_000);
  const bad = await showPopup({ text: "x", outcomeFile: NOWHERE, spawn: () => { throw new Error("spawn EPERM"); } });
  assert.deepEqual(bad, { started: false, detail: "popup not shown: spawn EPERM" });
  const noFile = await showPopup({ text: "x", spawn: () => assert.fail("no spawn without an outcome file") });
  assert.deepEqual(noFile, { started: false, detail: "popup not shown: no outcome file to confirm delivery in" });
});

test("popup: an asynchronous spawn error, an early non-zero exit, and an early exit 0 are each the outcome, not a crash or a false start", async () => {
  const opts = { text: "x", outcomeFile: NOWHERE, token: "t" };
  const erroring = fakeChild();
  const p1 = showPopup({ ...opts, graceMs: 500, spawn: () => erroring });
  erroring.emit("error", Object.assign(new Error("spawn /usr/bin/osascript ENOENT"), { code: "ENOENT" }));
  assert.deepEqual(await p1, { started: false, detail: "popup not shown: spawn /usr/bin/osascript ENOENT" });

  const dying = fakeChild();
  const p2 = showPopup({ ...opts, graceMs: 500, spawn: () => dying });
  dying.emit("exit", 1, null);
  assert.deepEqual(await p2, { started: false, detail: `popup not shown: ${OSASCRIPT} ended with exit 1 within 500 ms` });

  const signalled = fakeChild();
  const p3 = showPopup({ ...opts, graceMs: 500, spawn: () => signalled });
  signalled.emit("exit", null, "SIGKILL");
  assert.deepEqual(await p3, { started: false, detail: `popup not shown: ${OSASCRIPT} ended by SIGKILL within 500 ms` });

  const quick = fakeChild();
  const p4 = showPopup({ ...opts, graceMs: 500, spawn: () => quick });
  quick.emit("exit", 0, null);
  assert.deepEqual(await p4, { started: true, seen: false, detail: `popup shown (${OSASCRIPT} under supervisor pid 42, ended within 500 ms, no answer recorded)` });

  const twice = fakeChild();
  const p5 = showPopup({ ...opts, graceMs: 20, spawn: () => twice });
  twice.emit("exit", 2, null);
  twice.emit("error", new Error("late"));
  assert.equal((await p5).started, false, "the first outcome wins; later events are ignored");
});

test("popup with real children (never osascript): a missing executable is `popup not shown` with ENOENT, a fast-failing one with its exit code; the supervisor records each", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-popup-"));
  try {
    const outcomeFile = join(dir, "popup.json");
    const t = Date.now();
    const missing = await showPopup({ text: "probe only; no dialog", bin: join(dir, "definitely-not-a-ctx-watch-executable"), graceMs: 5_000, outcomeFile, token: "m" });
    assert.equal(missing.started, false);
    assert.match(missing.detail, /^popup not shown: spawn .*definitely-not-a-ctx-watch-executable ENOENT$/);
    assert.ok(Date.now() - t < 5_000, "the error settles it before the grace");
    assert.equal(readOutcome(outcomeFile).token, "m");
    // `/bin/sh -e "display dialog …"`: sh takes `-e` as an option and the script as a file to run, which does not exist, and exits at once.
    const failing = await showPopup({ text: "probe only; no dialog", bin: "/bin/sh", graceMs: 5_000, outcomeFile, token: "f" });
    assert.equal(failing.started, false);
    assert.match(failing.detail, /^popup not shown: \/bin\/sh ended with exit [1-9]\d* within 5000 ms$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("popup with a real supervisor: a child that outlives the grace and then exits 7 is recorded as a failure, and one that exits 0 as delivered, each in its token's own file (never osascript)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-popup-"));
  try {
    const late = await showPopup({ text: "probe only; no dialog", bin: fakeOsascript(dir, 0.6, 7), graceMs: 150, outcomeFile: outcomePath(dir, "late"), token: "late" });
    assert.equal(late.started, true);
    assert.equal(late.pending, true, "alive at the grace: pending, not delivered");
    const failed = await waitForOutcome(outcomePath(dir, "late"), "late");
    assert.deepEqual({ code: failed.code, signal: failed.signal, error: failed.error, acknowledged: failed.acknowledged, bin: failed.bin }, { code: 7, signal: null, error: null, acknowledged: false, bin: join(dir, "osascript-7") });

    const ok = await showPopup({ text: "probe only; no dialog", bin: fakeOsascript(dir, 0.6, 0), graceMs: 150, outcomeFile: outcomePath(dir, "ok"), token: "ok" });
    assert.equal(ok.pending, true);
    assert.equal((await waitForOutcome(outcomePath(dir, "ok"), "ok")).code, 0);
    assert.equal(readOutcome(outcomePath(dir, "late")).code, 7, "the later supervisor did not replace the earlier one's outcome");
    assert.deepEqual(readdirSync(join(dir, "popups")).sort(), ["late.json", "ok.json"], "one file per token, no temp files left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outcomePath: <dir>/popups/<token>.json for a token of letters, digits, - and _; anything else (a path, empty, over 100) is null, and reads as no outcome", () => {
  assert.equal(outcomePath("/s", "1793784000000-123"), join("/s", "popups", "1793784000000-123.json"));
  for (const bad of ["", "../x", "a/b", ".", "x".repeat(101), null, 7]) assert.equal(outcomePath("/s", bad), null, String(bad));
  assert.equal(readOutcome(outcomePath("/s", "../x")), null);
});

test("readOutcome: the file, or null when missing, not JSON, or out of shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-watch-popup-"));
  try {
    const f = join(dir, "popup.json");
    assert.equal(readOutcome(f), null);
    const good = { token: "t", at: 1, bin: OSASCRIPT, code: 7, signal: null, error: null, acknowledged: false, gaveUp: null };
    writeFileSync(f, JSON.stringify(good));
    assert.deepEqual(readOutcome(f), good);
    for (const bad of ["nope", JSON.stringify({ ...good, code: "7" }), JSON.stringify({ ...good, token: "" }), JSON.stringify({ ...good, at: -1 }), JSON.stringify({ ...good, acknowledged: "yes" })]) {
      writeFileSync(f, bad);
      assert.equal(readOutcome(f), null, bad);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
