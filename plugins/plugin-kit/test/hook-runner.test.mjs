// hook-runner.test.mjs — the fail-open runner (README "What it does"): a handler's object is
// printed and exit is 0; null prints nothing; empty stdin is `{}`; stdin not JSON, a thrown error,
// a rejected promise and a handler past the deadline each exit 0 with one errors.log line and a
// systemMessage (none on quiet); the log is under ${XDG_STATE_HOME}/<plugin>/.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, errorsLogPath, stateDir } from "../lib/hook-runner.mjs";

function box() {
  const root = mkdtempSync(join(tmpdir(), "kit-runner-"));
  const env = { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state") };
  return { root, env, log: () => {
    try {
      return readFileSync(errorsLogPath("trial", env), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  } };
}
/** Run the runner with `stdin` text and capture exit code and stdout. */
async function drive(b, fn, stdin, opts = {}) {
  const path = join(b.root, `stdin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, stdin);
  let code = null;
  let out = "";
  await runHook("Stop", fn, { plugin: "trial", env: b.env, stdin: path, exit: (c) => (code = c), write: (s) => (out += s), ...opts });
  return { code, out, json: out ? JSON.parse(out) : null };
}

test("a handler's object is printed with exit 0; null prints nothing; empty stdin is an empty object", async () => {
  const b = box();
  const r = await drive(b, (input) => ({ seen: input.x }), '{"x":1}');
  assert.deepEqual([r.code, r.json], [0, { seen: 1 }]);
  const n = await drive(b, () => null, '{"x":1}');
  assert.deepEqual([n.code, n.out], [0, ""]);
  let got;
  const e = await drive(b, (input) => ((got = input), null), "");
  assert.deepEqual([e.code, got], [0, {}]);
  assert.deepEqual(b.log(), []);
});

test("stdin not JSON, or not an object: exit 0, one errors.log line, a systemMessage; quiet drops the message", async () => {
  const b = box();
  const r = await drive(b, () => ({ never: true }), "{not json");
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /^trial Stop failed open: stdin not JSON: /);
  const arr = await drive(b, () => ({ never: true }), "[1,2]");
  assert.match(arr.json.systemMessage, /stdin not JSON: payload is not an object/);
  const q = await drive(b, () => ({ never: true }), "{not json", { quiet: true });
  assert.deepEqual([q.code, q.out], [0, ""]);
  const lines = b.log();
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+ Stop stdin not JSON: /);
  assert.equal(stateDir("trial", b.env), join(b.env.XDG_STATE_HOME, "trial"));
});

test("a thrown error or a rejected promise: exit 0, one errors.log line with the message, a systemMessage", async () => {
  const b = box();
  const t = await drive(b, () => {
    throw new Error("boom");
  }, "{}");
  assert.equal(t.code, 0);
  assert.equal(t.json.systemMessage, "trial Stop failed open: boom");
  const p = await drive(b, async () => Promise.reject(new Error("later")), "{}");
  assert.equal(p.json.systemMessage, "trial Stop failed open: later");
  const lines = b.log();
  assert.equal(lines.length, 2);
  assert.match(lines[0], / Stop boom \| /);
});

test("a handler past the deadline: exit 0 at the deadline with the line and the message, not when the handler finally returns", async () => {
  const b = box();
  const started = Date.now();
  const r = await drive(b, () => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 2_000)), "{}", { deadlineMs: 100 });
  const ms = Date.now() - started;
  assert.equal(r.code, 0);
  assert.ok(ms < 1_000, `${ms} ms`);
  assert.equal(r.json.systemMessage, "trial Stop failed open: no answer within 100 ms");
  assert.match(b.log()[0], / Stop no answer within 100 ms$/);
});

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "hook-runner.mjs");

/** A hook script in the box that runs `body` (JS source for the handler) through the real runner with a 150 ms deadline. */
function hookScript(b, body) {
  const path = join(b.root, `hook-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `import { runHook } from ${JSON.stringify(RUNNER)};\nrunHook("PreToolUse", ${body}, { plugin: "trial", deadlineMs: 150 });\n`);
  return path;
}
const parse = (out) => (out.trim() ? JSON.parse(out) : null);

test("spawned: a handler promise that never settles, with no other handle alive, exits 0 at the deadline with the message (the timer is referenced)", () => {
  const b = box();
  const started = Date.now();
  const r = spawnSync(process.execPath, [hookScript(b, "() => new Promise(() => {})")], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 5_000 });
  const ms = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 3_000, `${ms} ms`);
  assert.equal(parse(r.stdout)?.systemMessage, "trial PreToolUse failed open: no answer within 150 ms");
  assert.match(b.log()[0], / PreToolUse no answer within 150 ms$/);
});

test("spawned: stdin the host holds open counts against the deadline: exit 0 with the message, never a hang", async () => {
  const b = box();
  const started = Date.now();
  const child = spawn(process.execPath, [hookScript(b, "() => ({ decision: 'block', reason: 'never' })")], { env: { ...process.env, ...b.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write("{}"); // never ended
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const ms = Date.now() - started;
  child.stdin.destroy();
  assert.equal(code, 0);
  assert.ok(ms < 3_000, `${ms} ms`);
  assert.equal(parse(out)?.systemMessage, "trial PreToolUse failed open: no answer within 150 ms");
});

test("spawned: a handler that blocks the loop past the deadline: its late block is dropped, exit 0 with the message naming when the answer came", () => {
  const b = box();
  const body = "() => { const end = Date.now() + 400; while (Date.now() < end) {} return { decision: 'block', reason: 'late' }; }";
  const r = spawnSync(process.execPath, [hookScript(b, body)], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 5_000 });
  assert.equal(r.status, 0, r.stderr);
  const json = parse(r.stdout);
  assert.equal(json?.decision, undefined, r.stdout);
  assert.match(json?.systemMessage ?? "", /^trial PreToolUse failed open: no answer within 150 ms \(the answer came after \d+ ms\)$/);
  assert.equal(b.log().length, 1, "one line, not one per path");
});

test("spawned: a handler that answers in time prints its answer and nothing else", () => {
  const b = box();
  const r = spawnSync(process.execPath, [hookScript(b, "(input) => ({ seen: input.hook_event_name })")], { input: '{"hook_event_name":"PreToolUse"}', encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 5_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parse(r.stdout), { seen: "PreToolUse" });
  assert.deepEqual(b.log(), []);
});

test("runHook without { plugin } is a programming error, thrown at once", async () => {
  await assert.rejects(runHook("Stop", () => null, {}), /needs \{ plugin \}/);
});

test("a state directory that cannot be made: the hook still exits 0 with the message; the line is lost", async () => {
  const b = box();
  const file = join(b.root, "not-a-dir");
  writeFileSync(file, "x");
  const r = await drive(b, () => {
    throw new Error("boom");
  }, "{}", { env: { ...b.env, XDG_STATE_HOME: file } });
  assert.equal(r.code, 0);
  assert.equal(r.json.systemMessage, "trial Stop failed open: boom");
});
