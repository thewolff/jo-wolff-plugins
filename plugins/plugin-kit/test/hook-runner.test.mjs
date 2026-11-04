// hook-runner.test.mjs — the fail-open runner (README "What it does"): a handler's object is
// printed and exit is 0; null prints nothing; empty stdin is `{}`; stdin not JSON, a thrown error,
// a rejected promise and a handler past the deadline each exit 0 with one errors.log line and a
// systemMessage (none on quiet); an answer larger than a pipe buffer is drained before the exit,
// bounded by the deadline; the log is under ${XDG_STATE_HOME}/<plugin>/.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
/** A hook module in the box whose `handle` is `body` (JS source for a function); returns its URL. */
function handlerModule(b, body) {
  const path = join(b.root, `handler-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `export const handle = ${body};\n`);
  return pathToFileURL(path).href;
}
/** Run the runner in this process with `stdin` text and a handler from `body`; capture exit code and stdout. */
async function drive(b, body, stdin, opts = {}) {
  const path = join(b.root, `stdin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, stdin);
  let code = null;
  let out = "";
  await runHook("Stop", handlerModule(b, body), { plugin: "trial", env: b.env, stdin: path, exit: (c) => (code = c), write: (s, done) => ((out += s), done()), ...opts });
  return { code, out, json: out ? JSON.parse(out) : null };
}

test("a handler's object is printed with exit 0; null prints nothing; empty stdin is an empty object", async () => {
  const b = box();
  const r = await drive(b, "(input) => ({ seen: input.x })", '{"x":1}');
  assert.deepEqual([r.code, r.json], [0, { seen: 1 }]);
  const n = await drive(b, "() => null", '{"x":1}');
  assert.deepEqual([n.code, n.out], [0, ""]);
  const e = await drive(b, "(input) => ({ got: input })", "");
  assert.deepEqual([e.code, e.json], [0, { got: {} }]);
  // The handler sees the runner's env, not the test process's.
  const v = await drive(b, "(input, { env }) => ({ state: env.XDG_STATE_HOME })", "{}");
  assert.deepEqual(v.json, { state: b.env.XDG_STATE_HOME });
  assert.deepEqual(b.log(), []);
});

test("stdin not JSON, or not an object: exit 0, one errors.log line, a systemMessage; quiet drops the message", async () => {
  const b = box();
  const r = await drive(b, "() => ({ never: true })", "{not json");
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /^trial Stop failed open: stdin not JSON: /);
  const arr = await drive(b, "() => ({ never: true })", "[1,2]");
  assert.match(arr.json.systemMessage, /stdin not JSON: payload is not an object/);
  const q = await drive(b, "() => ({ never: true })", "{not json", { quiet: true });
  assert.deepEqual([q.code, q.out], [0, ""]);
  const lines = b.log();
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\S+ Stop stdin not JSON: /);
  assert.equal(stateDir("trial", b.env), join(b.env.XDG_STATE_HOME, "trial"));
});

test("a thrown error or a rejected promise: exit 0, one errors.log line with the message, a systemMessage", async () => {
  const b = box();
  const t = await drive(b, '() => { throw new Error("boom"); }', "{}");
  assert.equal(t.code, 0);
  assert.equal(t.json.systemMessage, "trial Stop failed open: boom");
  const p = await drive(b, 'async () => Promise.reject(new Error("later"))', "{}");
  assert.equal(p.json.systemMessage, "trial Stop failed open: later");
  // A module with no handle(), and one that does not parse: faults of the plugin, not denials.
  const none = await runHookTo(b, handlerModule(b, "null; export const other = 1"), "{}");
  assert.match(none.json.systemMessage, /^trial Stop failed open: .* exports no handle\(\)$/);
  const broken = await runHookTo(b, handlerModule(b, "() => {"), "{}");
  assert.match(broken.json.systemMessage, /^trial Stop failed open: /);
  const lines = b.log();
  assert.equal(lines.length, 4);
  assert.match(lines[0], / Stop boom \| /);
});

/** Like drive, with a ready module URL. */
async function runHookTo(b, url, stdin, opts = {}) {
  const path = join(b.root, `stdin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, stdin);
  let code = null;
  let out = "";
  await runHook("Stop", url, { plugin: "trial", env: b.env, stdin: path, exit: (c) => (code = c), write: (s, done) => ((out += s), done()), ...opts });
  return { code, out, json: out ? JSON.parse(out) : null };
}

test("a handler past the deadline: exit 0 at the deadline with the line and the message, not when the handler finally returns", async () => {
  const b = box();
  const started = Date.now();
  const r = await drive(b, "() => new Promise((resolve) => setTimeout(() => resolve({ late: true }), 2_000))", "{}", { deadlineMs: 100 });
  const ms = Date.now() - started;
  assert.equal(r.code, 0);
  assert.ok(ms < 1_000, `${ms} ms`);
  assert.equal(r.json.systemMessage, "trial Stop failed open: no answer within 100 ms");
  assert.match(b.log()[0], / Stop no answer within 100 ms$/);
});

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "hook-runner.mjs");

/** A hook script in the box, shaped like the template: exports `handle` (from `body`) and runs itself through the real runner (150 ms deadline unless `deadlineMs` says otherwise). */
function hookScript(b, body, deadlineMs = 150) {
  const path = join(b.root, `hook-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `import { runHook, invokedDirectly } from ${JSON.stringify(RUNNER)};\nexport const handle = ${body};\nif (invokedDirectly(import.meta.url)) runHook("PreToolUse", import.meta.url, { plugin: "trial", deadlineMs: ${deadlineMs} });\n`);
  return path;
}
const parse = (out) => (out.trim() ? JSON.parse(out) : null);

test("spawned: a handler that holds a timer and never answers exits 0 at the deadline with the message (the main thread's timer is referenced); a promise nothing will settle ends the thread and is named at once", () => {
  const b = box();
  const started = Date.now();
  const r = spawnSync(process.execPath, [hookScript(b, "() => new Promise(() => { setInterval(() => {}, 1_000); })")], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 5_000 });
  const ms = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 3_000, `${ms} ms`);
  assert.equal(parse(r.stdout)?.systemMessage, "trial PreToolUse failed open: no answer within 150 ms");
  assert.match(b.log()[0], / PreToolUse no answer within 150 ms$/);
  const dead = spawnSync(process.execPath, [hookScript(b, "() => new Promise(() => {})")], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 5_000 });
  assert.equal(dead.status, 0, dead.stderr);
  assert.match(parse(dead.stdout)?.systemMessage, /^trial PreToolUse failed open: the handler thread ended \(code 0\) without an answer/);
  assert.equal(b.log().length, 2);
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

test("spawned: a handler that never yields (a synchronous spin) ends at the deadline, not when it would have returned: exit 0 inside the budget with the message, its late block never printed", () => {
  const b = box();
  const started = Date.now();
  const body = "() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_000); return { decision: 'block', reason: 'late' }; }";
  const r = spawnSync(process.execPath, [hookScript(b, body, 400)], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 8_000 });
  const ms = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 2_000, `${ms} ms: the deadline did not end the run`);
  const json = parse(r.stdout);
  assert.equal(json?.decision, undefined, r.stdout);
  assert.equal(json?.systemMessage, "trial PreToolUse failed open: no answer within 400 ms");
  assert.deepEqual(b.log().map((l) => l.replace(/^\S+ /, "")), ["PreToolUse no answer within 400 ms"], "one complete line, written before exit");
});

test("spawned, the default deadline: a synchronous 6 s handler exits 0 within 4.5 s wall clock (inside the host's 5 s budget)", () => {
  const b = box();
  const started = Date.now();
  const body = "() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_000); return { decision: 'block', reason: 'late' }; }";
  const r = spawnSync(process.execPath, [hookScript(b, body, 4_000)], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 9_000 });
  const ms = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 4_500, `${ms} ms`);
  assert.ok(ms >= 3_900, `${ms} ms: the deadline, not something earlier`);
  assert.equal(parse(r.stdout)?.systemMessage, "trial PreToolUse failed open: no answer within 4000 ms");
});

test("spawned: a handler that answers in time prints its answer and nothing else", () => {
  const b = box();
  const r = spawnSync(process.execPath, [hookScript(b, "(input) => ({ seen: input.hook_event_name })")], { input: '{"hook_event_name":"PreToolUse"}', encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 5_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parse(r.stdout), { seen: "PreToolUse" });
  assert.deepEqual(b.log(), []);
});

test("spawned: the handler thread sees the runner's start and deadline in its env; a judge process group it started is killed when the runner gives up at its deadline", async () => {
  const b = box();
  const before = Date.now();
  const seen = spawnSync(process.execPath, [hookScript(b, "(input, { env }) => ({ at: Number(env.HOOK_RUNNER_STARTED_AT_MS), deadline: env.HOOK_RUNNER_DEADLINE_MS })", 900)], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 5_000 });
  assert.equal(seen.status, 0, seen.stderr);
  const { at, deadline } = parse(seen.stdout);
  assert.ok(at >= before && at <= Date.now(), `${at}`);
  assert.equal(deadline, "900");

  const pidFile = join(b.root, "judge.pid");
  const judgeUrl = pathToFileURL(join(dirname(RUNNER), "judge.mjs")).href;
  const command = `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30`;
  const body = `async () => { const { dispatch } = await import(${JSON.stringify(judgeUrl)}); await dispatch("p", { command: ${JSON.stringify(command)}, timeoutMs: 30_000 }); return { late: true }; }`;
  const started = Date.now();
  const r = spawnSync(process.execPath, [hookScript(b, body, 900)], { input: "{}", encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 8_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 3_000, "the deadline ended the run, not the judge");
  assert.equal(parse(r.stdout)?.systemMessage, "trial PreToolUse failed open: no answer within 900 ms");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 0);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 20 && alive(); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(alive(), false, `judge pid ${pid} outlived the hook`);
});

test("spawned: an answer larger than a pipe buffer, read slowly by the host, reaches stdout whole before exit 0, inside the deadline", async () => {
  const b = box();
  const bytes = 300_000;
  const started = Date.now();
  const child = spawn(process.execPath, [hookScript(b, `() => ({ text: "x".repeat(${bytes}) })`, 2_000)], { env: { ...process.env, ...b.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("{}");
  // A slow host: after every chunk it stops reading for 30 ms, so the pipe fills more than once.
  const chunks = [];
  child.stdout.on("data", (c) => {
    chunks.push(c);
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 30);
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => (child.stdout.readableEnded ? resolve() : child.stdout.on("end", resolve)));
  const ms = Date.now() - started;
  const out = Buffer.concat(chunks);
  assert.equal(code, 0);
  assert.ok(out.length > 65_536, `stdout was ${out.length} bytes`);
  assert.equal(JSON.parse(out.toString("utf8")).text.length, bytes, "nothing past the first pipe buffer was lost");
  assert.ok(ms < 2_000, `${ms} ms: past the deadline`);
  assert.deepEqual(b.log(), []);
});

test("spawned: a host that never reads stdout → exit 0 at the deadline, one errors.log line naming the undrained answer", async () => {
  const b = box();
  const started = Date.now();
  const child = spawn(process.execPath, [hookScript(b, `() => ({ text: "x".repeat(${8 * 1024 * 1024}) })`, 1_500)], { env: { ...process.env, ...b.env }, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.end("{}");
  // stdout is never read: the pipe fills and stays full.
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const ms = Date.now() - started;
  child.stdout.destroy();
  assert.equal(code, 0);
  assert.ok(ms < 2_500, `exited after ${ms} ms`);
  const lines = b.log();
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^\S+ PreToolUse stdout not drained within \d+ ms: the host is not reading it; the rest of a \d+-byte answer was dropped$/);
});

test("runHook without { plugin }, or with a function instead of the module URL, is a programming error, thrown at once", async () => {
  await assert.rejects(runHook("Stop", "file:///x.mjs", {}), /needs \{ plugin \}/);
  await assert.rejects(runHook("Stop", () => null, { plugin: "trial" }), /needs the hook module's import.meta.url/);
});

test("a state directory that cannot be made: the hook still exits 0 with the message; the line is lost", async () => {
  const b = box();
  const file = join(b.root, "not-a-dir");
  writeFileSync(file, "x");
  const r = await drive(b, '() => { throw new Error("boom"); }', "{}", { env: { ...b.env, XDG_STATE_HOME: file } });
  assert.equal(r.code, 0);
  assert.equal(r.json.systemMessage, "trial Stop failed open: boom");
});
