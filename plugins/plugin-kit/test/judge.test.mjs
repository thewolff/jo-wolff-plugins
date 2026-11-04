// judge.test.mjs — lib/judge.mjs: the resolution order over a fake HOME and XDG_CONFIG_HOME, each
// dispatch failure class driven by a tiny shell command, json and yesno parsing, the setup and
// which CLI as spawned processes, and the sameness test: every copy a plugin ships is this file.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT_ROOT } from "../scripts/new-plugin.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  ERRORS,
  dispatch,
  isJudgeError,
  lastJsonObject,
  legacyProfilePath,
  lookedIn,
  parseAnswer,
  resolveJudgeCommand,
  runJudge,
  sharedConfigPath,
  topLevelJsonSpans,
  writeSharedConfig,
} from "../lib/judge.mjs";

const LIB = join(KIT_ROOT, "lib", "judge.mjs");
const PLUGINS = join(KIT_ROOT, "..");

/** A fresh HOME and XDG_CONFIG_HOME, and an env with nothing of the user's judge settings in it. */
function box() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-judge-")));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdg };
  const put = (path, obj) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  return { root, home, xdg, env, put, shared: join(xdg, "judge", "config.json"), legacy: join(home, ".claude", "i-have-audhd.json") };
}

// ─── resolution ─────────────────────────────────────────────────────────────────────────

test("paths: the shared file under XDG_CONFIG_HOME, else ~/.config; the legacy profile under ~/.claude, else $I_HAVE_AUDHD_PROFILE", () => {
  const b = box();
  assert.equal(sharedConfigPath({ env: b.env }), b.shared);
  assert.equal(sharedConfigPath({ env: { HOME: b.home } }), join(b.home, ".config", "judge", "config.json"));
  assert.equal(sharedConfigPath({ env: {}, home: b.home, xdgConfigHome: "/x" }), "/x/judge/config.json");
  assert.equal(legacyProfilePath({ env: b.env }), b.legacy);
  assert.equal(legacyProfilePath({ env: { ...b.env, I_HAVE_AUDHD_PROFILE: "/p/profile.json" } }), "/p/profile.json");
});

test("resolution order: env var → plugin's own → shared file → legacy profile → null, each naming its source", () => {
  const b = box();
  const key = { envVar: "TRIAL_JUDGE_BIN", command: null, source: "review.judgeCommand in /trial/config.json" };
  assert.equal(resolveJudgeCommand({ pluginKey: key, env: b.env }), null);
  assert.deepEqual(lookedIn({ pluginKey: key, env: b.env }), ["env TRIAL_JUDGE_BIN", key.source, b.shared, `enforcement.judgeCommand in ${b.legacy}`]);

  b.put(b.legacy, { enforcement: { judgeCommand: "legacy-cmd" } });
  assert.deepEqual(resolveJudgeCommand({ pluginKey: key, env: b.env }), { command: "legacy-cmd", timeoutMs: DEFAULT_TIMEOUT_MS, source: `enforcement.judgeCommand in ${b.legacy} (legacy)` });

  b.put(b.shared, { command: "shared-cmd", timeoutMs: 1234 });
  assert.deepEqual(resolveJudgeCommand({ pluginKey: key, env: b.env }), { command: "shared-cmd", timeoutMs: 1234, source: b.shared });

  const own = { ...key, command: "own-cmd" };
  assert.deepEqual(resolveJudgeCommand({ pluginKey: own, env: b.env }), { command: "own-cmd", timeoutMs: 1234, source: key.source });
  assert.equal(resolveJudgeCommand({ pluginKey: { ...own, timeoutMs: 99 }, env: b.env }).timeoutMs, 99, "the plugin's own timeout wins over the shared one");
  assert.equal(resolveJudgeCommand({ pluginKey: { command: "own-cmd" }, env: b.env }).source, "plugin config");

  const env = { ...b.env, TRIAL_JUDGE_BIN: "env-cmd" };
  assert.deepEqual(resolveJudgeCommand({ pluginKey: own, env }), { command: "env-cmd", timeoutMs: 1234, source: "env TRIAL_JUDGE_BIN" });
  assert.equal(resolveJudgeCommand({ pluginKey: own, env: { ...b.env, TRIAL_JUDGE_BIN: "  " } }).command, "own-cmd", "a blank env var is unset");
});

test("resolution: a shared or legacy file that is absent, not JSON, not an object, or without a command string is skipped; home and xdgConfigHome overrides are honoured", () => {
  const b = box();
  b.put(b.shared, "{not json");
  b.put(b.legacy, "[1]");
  assert.equal(resolveJudgeCommand({ env: b.env }), null);
  b.put(b.shared, { command: 42 });
  b.put(b.legacy, { enforcement: { judgeCommand: "" } });
  assert.equal(resolveJudgeCommand({ env: b.env }), null);
  b.put(b.shared, { command: "c", timeoutMs: "not a number" });
  assert.equal(resolveJudgeCommand({ env: b.env }).timeoutMs, DEFAULT_TIMEOUT_MS);
  const other = box();
  other.put(other.shared, { command: "elsewhere" });
  assert.equal(resolveJudgeCommand({ env: {}, home: other.home, xdgConfigHome: other.xdg }).command, "elsewhere");
  assert.equal(resolveJudgeCommand({ env: { HOME: "/nowhere", XDG_CONFIG_HOME: "/nowhere" }, home: b.home, xdgConfigHome: b.xdg }).command, "c", "home and xdgConfigHome override the env");
});

// ─── dispatch and the failure classes ───────────────────────────────────────────────────

test("dispatch: the prompt arrives on stdin without a placeholder, substituted shell-escaped with one; stdout only is captured", async () => {
  const r = await dispatch("it's {a}", { command: "cat; echo noise >&2" });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "it's {a}");
  assert.equal(r.stderr, "noise\n");
  assert.equal(r.code, 0);
  const p = await dispatch("it's \"q\" $HOME", { command: "printf '%s' {prompt}; printf '%s' {prompt}" });
  assert.equal(p.stdout, "it's \"q\" $HOMEit's \"q\" $HOME");
});

test("the four failure classes, each from a tiny shell command, never a throw", async () => {
  assert.deepEqual(ERRORS, ["timeout", "nonzero", "unparseable", "spawn-failed"]);
  const timeout = await runJudge("p", { command: "sleep 5; echo '{\"late\":true}'", timeoutMs: 200 });
  assert.equal(timeout.error, "timeout");
  assert.match(timeout.detail, /no exit within 200 ms/);
  assert.ok(isJudgeError(timeout));
  const nonzero = await runJudge("p", { command: "echo '{\"a\":1}'; echo why >&2; exit 3" });
  assert.equal(nonzero.error, "nonzero");
  assert.equal(nonzero.detail, "exit 3");
  assert.equal(nonzero.stderr, "why\n", "stderr rides the failure so the reason is loggable");
  const unparseable = await runJudge("p", { command: "echo 'no json here'" });
  assert.equal(unparseable.error, "unparseable");
  const spawnFailed = await runJudge("p", { command: "" });
  assert.equal(spawnFailed.error, "spawn-failed");
  assert.equal(spawnFailed.detail, "no command");
  const missing = await runJudge("p", { command: "/no/such/binary-xyz" });
  assert.equal(missing.error, "nonzero", "sh reports a missing program as exit 127");
  assert.equal(missing.detail, "exit 127");
  assert.ok(!isJudgeError({ verdict: "pass" }));
  assert.ok(!isJudgeError({ error: "something else" }));
  assert.ok(!isJudgeError(null));
});

test("timeout: the whole process group is reaped, so a backgrounded child does not hold the caller", async () => {
  const started = Date.now();
  const r = await dispatch("p", { command: "sleep 30 & sleep 30", timeoutMs: 150 });
  assert.equal(r.error, "timeout");
  assert.ok(Date.now() - started < 2_000, "settled on the timer, not on the sleeps");
});

// ─── parsing ────────────────────────────────────────────────────────────────────────────

test("json mode: the last top-level object on stdout, past banner lines; braces in strings do not end a span; a claude -p envelope is unwrapped", async () => {
  const banner = "session abc\n{\"verdict\":\"fail\",\"reason\":\"first\"}\n{\"verdict\":\"pass\",\"reason\":\"a } in a string\"}\n";
  assert.deepEqual(lastJsonObject(banner), { verdict: "pass", reason: "a } in a string" });
  assert.deepEqual(topLevelJsonSpans('x {"a":"}"} y {"b":{"c":1}}'), ['{"a":"}"}', '{"b":{"c":1}}']);
  const envelope = JSON.stringify({ type: "result", result: 'Sure.\n```json\n{"verdict":"fail","reason":"r"}\n```' });
  assert.deepEqual(lastJsonObject(envelope), { verdict: "fail", reason: "r" });
  const envelopeNoInner = JSON.stringify({ type: "result", result: "plain text" });
  assert.deepEqual(lastJsonObject(envelopeNoInner), { type: "result", result: "plain text" });
  assert.equal(lastJsonObject("{broken"), null);
  assert.equal(lastJsonObject("[1,2]"), null);
  const r = await runJudge("p", { command: "printf '%s\\n' 'session abc' '{\"verdict\":\"fail\"}' '{\"verdict\":\"pass\",\"reason\":\"a } in a string\"}'" });
  assert.deepEqual(r, { verdict: "pass", reason: "a } in a string" });
});

test("yesno mode: the last non-empty line's first word, stripped of markdown; anything else, and every failure, is unverified", async () => {
  assert.equal(parseAnswer("Thinking…\n\n**Yes**, it does."), "yes");
  assert.equal(parseAnswer("> no\n"), "no");
  assert.equal(parseAnswer("maybe"), null);
  assert.equal(parseAnswer(""), null);
  assert.equal(parseAnswer("biting", ["biting", "silent", "fine"]), "biting");
  assert.equal(await runJudge("p", { command: "echo 'reasoning'; echo 'NO.'", mode: "yesno" }), "no");
  assert.equal(await runJudge("p", { command: "echo yes", mode: "yesno" }), "yes");
  assert.equal(await runJudge("p", { command: "echo perhaps", mode: "yesno" }), "unverified");
  assert.equal(await runJudge("p", { command: "echo yes; exit 1", mode: "yesno" }), "unverified");
  assert.equal(await runJudge("p", { command: "sleep 5", mode: "yesno", timeoutMs: 100 }), "unverified");
  assert.equal(await runJudge("p", { command: "", mode: "yesno" }), "unverified");
});

// ─── the CLI ────────────────────────────────────────────────────────────────────────────

function cli(b, args, input = "") {
  return spawnSync(process.execPath, [LIB, ...args], { env: b.env, input, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
}

test("setup --command --yes: one test call, then the shared file, atomically and private, other keys kept", () => {
  const b = box();
  b.put(b.shared, { other: "kept" });
  const modeBefore = statSync(b.shared).mode & 0o777;
  const r = cli(b, ["setup", "--command", "echo '{\"ok\":true}'", "--timeout-ms", "5000", "--yes"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /current: none/);
  assert.match(r.stdout, /ok in \d+ ms: \{"ok":true\}/);
  assert.match(r.stdout, new RegExp(`written: ${b.shared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(JSON.parse(readFileSync(b.shared, "utf8")), { other: "kept", command: "echo '{\"ok\":true}'", timeoutMs: 5000 });
  assert.equal(readdirSync(join(b.xdg, "judge")).filter((f) => f.includes(".tmp")).length, 0, "no temp file left");
  assert.equal(statSync(b.shared).mode & 0o777, modeBefore, "an existing file keeps its mode");
  assert.deepEqual(resolveJudgeCommand({ env: b.env }), { command: "echo '{\"ok\":true}'", timeoutMs: 5000, source: b.shared });
  const again = cli(b, ["setup", "--command", "echo '{\"ok\":true}'", "--yes"]);
  assert.match(again.stdout, /current: "echo '\{\\"ok\\":true\}'"/);
  assert.equal(JSON.parse(readFileSync(b.shared, "utf8")).timeoutMs, 5000, "a re-run keeps the stored timeout");
});

test("setup: a failed test call refuses to write (exit 1) unless --force; the reason is in plain words", () => {
  const b = box();
  const r = cli(b, ["setup", "--command", "echo nope; exit 2", "--yes"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /failed in \d+ ms: it exited non-zero .* \(exit 2\)/);
  assert.match(r.stderr, /not written; fix the command, or pass --force/);
  assert.ok(!existsSync(b.shared));
  const forced = cli(b, ["setup", "--command", "echo nope; exit 2", "--yes", "--force"]);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(JSON.parse(readFileSync(b.shared, "utf8")).command, "echo nope; exit 2");
  const unparseable = cli(b, ["setup", "--command", "echo plain", "--yes"]);
  assert.equal(unparseable.status, 1);
  assert.match(unparseable.stdout, /printed no JSON object on stdout/);
});

test("setup interactive: the command and the yes come from stdin; EOF or anything but yes writes nothing", () => {
  const b = box();
  const r = cli(b, ["setup"], "echo '{\"ok\":1}'\ny\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /command \(reads the prompt on stdin, or has \{prompt\} in it\): /);
  assert.match(r.stdout, /write\? \[y\/N\] /);
  if (process.getuid?.() !== 0) assert.equal(statSync(b.shared).mode & 0o777, 0o600, "a new file is private to its owner");
  assert.equal(JSON.parse(readFileSync(b.shared, "utf8")).command, "echo '{\"ok\":1}'");
  const c = box();
  assert.equal(cli(c, ["setup"], "echo '{\"ok\":1}'\nn\n").status, 1);
  assert.ok(!existsSync(c.shared));
  const eof = cli(c, ["setup"], "");
  assert.equal(eof.status, 2);
  assert.match(eof.stderr, /no command given/);
  assert.equal(cli(c, ["bogus"]).status, 2);
  assert.equal(cli(c, ["setup", "--what"]).status, 2);
});

test("which: prints command, timeoutMs and source; with nothing configured, where it looked, exit 1; --env-var adds the plugin's variable", () => {
  const b = box();
  const none = cli(b, ["which"]);
  assert.equal(none.status, 1);
  assert.equal(none.stdout, `no judge configured; looked in: ${b.shared}, enforcement.judgeCommand in ${b.legacy}\n`);
  b.put(b.legacy, { enforcement: { judgeCommand: "legacy" } });
  const legacy = cli(b, ["which"]);
  assert.equal(legacy.status, 0);
  assert.equal(legacy.stdout, `command=legacy\ntimeoutMs=${DEFAULT_TIMEOUT_MS}\nsource=enforcement.judgeCommand in ${b.legacy} (legacy)\n`);
  const viaEnv = spawnSync(process.execPath, [LIB, "which", "--env-var", "TRIAL_JUDGE_BIN"], { env: { ...b.env, TRIAL_JUDGE_BIN: "from-env" }, encoding: "utf8", timeout: 10_000 });
  assert.equal(viaEnv.stdout, `command=from-env\ntimeoutMs=${DEFAULT_TIMEOUT_MS}\nsource=env TRIAL_JUDGE_BIN\n`);
});

test("writeSharedConfig: creates the directory, keeps unrelated keys, replaces command and timeoutMs", () => {
  const b = box();
  const path = writeSharedConfig({ command: "a", timeoutMs: 10, env: b.env });
  assert.equal(path, b.shared);
  writeSharedConfig({ command: "b", timeoutMs: 20, env: { ...b.env, EXTRA: "1" } });
  assert.deepEqual(JSON.parse(readFileSync(b.shared, "utf8")), { command: "b", timeoutMs: 20 });
});

// ─── sameness: every shipped copy is this file ──────────────────────────────────────────

// Copies that are NOT yet this file: ledger keeps its own lib/judge.mjs and i-have-audhd its
// judge/ask.mjs until their next releases (jo-issues #333, "Sequencing"). Remove an entry here
// when that plugin vendors the kit's copy; a listed file that no longer exists is a failure, so a
// stale entry is noticed.
const NOT_YET_VENDORED = ["ledger/lib/judge.mjs"];

test("sameness: every plugins/*/lib/judge.mjs and plugins/*/judge/judge.mjs outside the allowlist is byte-identical to the kit's", () => {
  const canonical = readFileSync(LIB);
  const plugins = readdirSync(PLUGINS).filter((n) => statSync(join(PLUGINS, n)).isDirectory() && n !== "plugin-kit");
  const copies = plugins.flatMap((p) => ["lib/judge.mjs", "judge/judge.mjs"].map((rel) => `${p}/${rel}`)).filter((rel) => existsSync(join(PLUGINS, rel)));
  for (const rel of NOT_YET_VENDORED) assert.ok(existsSync(join(PLUGINS, rel)), `${rel} is allowlisted but gone: remove it from NOT_YET_VENDORED`);
  const checked = copies.filter((rel) => !NOT_YET_VENDORED.includes(rel));
  for (const rel of checked) assert.ok(canonical.equals(readFileSync(join(PLUGINS, rel))), `${rel} differs from plugin-kit/lib/judge.mjs: copy it again`);
});
