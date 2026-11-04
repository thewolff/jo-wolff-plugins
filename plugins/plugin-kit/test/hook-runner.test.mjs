// hook-runner.test.mjs — the fail-open runner (README "What it does"): a handler's object is
// printed and exit is 0; null prints nothing; empty stdin is `{}`; stdin not JSON, a thrown error,
// a rejected promise and a handler past the deadline each exit 0 with one errors.log line and a
// systemMessage (none on quiet); the log is under ${XDG_STATE_HOME}/<plugin>/.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
