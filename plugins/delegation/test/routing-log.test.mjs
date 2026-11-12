// test/routing-log.test.mjs — the spawn gate's routing log (lib/routing-log.mjs): one JSON line
// per examined spawn under the state directory, the hook spawned end-to-end. The log never
// changes a spawn decision and never carries the prompt.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { box, errorsLog, gitRepo, runHook, setConfig, spawnPayload, HOW_ONLY } from "./helpers.mjs";
import { LOCK_STALE_MS, MAX_BYTES, logRouting, routingLogPath } from "../lib/routing-log.mjs";

const lines = (env) => {
  try {
    return readFileSync(join(env.XDG_STATE_HOME, "delegation", "routing.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

function repoWithReceipt(env, session = "s-test-1") {
  const repo = gitRepo(join(env.HOME, "repo"), env);
  mkdirSync(join(repo, ".pattern-check"), { recursive: true });
  writeFileSync(join(repo, ".pattern-check", `${session}.md`), "# receipt\n");
  return repo;
}

const spawn = (env, repo, opts) => runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, ...opts }), env);

test("routing log: each outcome writes exactly one line with the documented fields", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  const cases = [
    [{ subagent_type: "reader", model: "sonnet" }, "match", "sonnet", "sonnet"],
    [{ subagent_type: "reader", model: "opus" }, "warned-above", "sonnet", "sonnet"],
    [{ subagent_type: "reader", model: null }, "no-model", "sonnet", "sonnet"],
    [{ subagent_type: "reviewer-codex", model: "fable" }, "unmapped", null, null],
    [{ subagent_type: "reader", model: "inherit" }, "not-checked", "sonnet", "sonnet"],
    [{ subagent_type: "reader", prompt: "no headings", model: "opus" }, "not-checked", null, null],
  ];
  for (const [i, [opts, outcome, tableModel, ceiling]] of cases.entries()) {
    const r = spawn(env, repo, { ...opts, extra: { description: `case ${i}` } });
    assert.equal(r.status, 0);
    const all = lines(env);
    assert.equal(all.length, i + 1, `${outcome}: one new line`);
    const l = all[i];
    assert.equal(l.outcome, outcome);
    assert.equal(l.subagent_type, opts.subagent_type);
    assert.equal(l.model, opts.model === null ? null : (opts.model ?? "haiku"));
    assert.equal(l.tableModel, tableModel);
    assert.equal(l.ceiling, ceiling);
    assert.equal(l.session_id, "s-test-1");
    assert.equal(l.cwd, repo);
    assert.equal(l.description, `case ${i}`);
    assert.match(l.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
});

test("routing log: a prompt with no string, a refused builder and an off warnModelRouting are each one not-checked line", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  const noPrompt = spawnPayload({ cwd: repo });
  delete noPrompt.tool_input.prompt;
  runHook("spawn-gate", noPrompt, env);
  runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "builder", session_id: "s-none" }), env);
  setConfig(env, { warnModelRouting: false });
  runHook("spawn-gate", spawnPayload({ cwd: repo, subagent_type: "reader", prompt: HOW_ONLY, model: "opus" }), env);
  assert.deepEqual(lines(env).map((l) => l.outcome), ["not-checked", "not-checked", "not-checked"]);
});

test("routing log: the prompt text never appears in the file, only the description", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  const secret = "ZZ-PROMPT-SENTINEL-4471";
  spawn(env, repo, { subagent_type: "reader", model: "sonnet", prompt: `# Target\n${secret}\n\n## How it fails\n- x\n`, extra: { description: "map the module" } });
  spawn(env, repo, { subagent_type: "reader", prompt: `${secret} no headings` });
  const raw = readFileSync(join(env.XDG_STATE_HOME, "delegation", "routing.jsonl"), "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.split("\n").filter(Boolean).length, 2);
  assert.match(raw, /"description":"map the module"/);
  // A sample line, as documented in the README.
  t.diagnostic(raw.split("\n")[0]);
});

test("routing log: an unwritable log is one errors.log line and the spawn answer is unchanged", (t) => {
  const { env } = box(t);
  const repo = repoWithReceipt(env);
  const ok = spawn(env, repo, { subagent_type: "reader", model: "opus" });
  const dir = join(env.XDG_STATE_HOME, "delegation");
  // routing.jsonl is a directory: the append fails with EISDIR.
  const logPath = join(dir, "routing.jsonl");
  assert.ok(existsSync(logPath));
  const { env: env2 } = box(t);
  const repo2 = repoWithReceipt(env2);
  mkdirSync(join(env2.XDG_STATE_HOME, "delegation", "routing.jsonl"), { recursive: true });
  const r = spawn(env2, repo2, { subagent_type: "reader", model: "opus" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.out, ok.out);
  assert.match(errorsLog(env2), /^\S+ spawn-gate routing log not written: EISDIR\n$/);
  // A deny stays a deny and a silent allow stays silent.
  assert.ok(spawn(env2, repo2, { subagent_type: "reader", prompt: "x" }).out.hookSpecificOutput.permissionDecision === "deny");
  assert.equal(spawn(env2, repo2, { subagent_type: "reader", model: "sonnet" }).out, null);
});

test("routing log: a state home that is a file still allows the spawn", (t) => {
  const { root, env } = box(t);
  const repo = repoWithReceipt(env);
  const blocked = join(root, "state-is-a-file");
  writeFileSync(blocked, "x");
  const r = runHook("spawn-gate", spawnPayload({ cwd: repo, prompt: HOW_ONLY, subagent_type: "reader", model: "sonnet" }), { ...env, XDG_STATE_HOME: blocked });
  assert.equal(r.status, 0);
  assert.equal(r.out, null);
});

test("routing log: logModelRouting false writes nothing and the model line still appears; a bad value is a config fault with the default on", (t) => {
  const { env } = box(t, { config: { logModelRouting: false } });
  const repo = repoWithReceipt(env);
  const r = spawn(env, repo, { subagent_type: "reader", model: "opus" });
  assert.match(r.out.hookSpecificOutput.additionalContext, /ceiling for reader is sonnet/);
  assert.equal(existsSync(join(env.XDG_STATE_HOME, "delegation", "routing.jsonl")), false);
  setConfig(env, { logModelRouting: "no" });
  const bad = spawn(env, repo, { subagent_type: "reader", model: "sonnet" });
  assert.match(bad.out.systemMessage, /logModelRouting must be true or false/);
  assert.equal(lines(env).length, 1);
});

test("routing log: past the cap the file moves to routing.jsonl.1 and a fresh file starts", (t) => {
  const { env } = box(t);
  const dir = join(env.XDG_STATE_HOME, "delegation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "routing.jsonl"), `${"x".repeat(MAX_BYTES)}\n`);
  logRouting("spawn-gate", { input: { session_id: "s" }, toolInput: { subagent_type: "reader" }, outcome: "match", row: null }, env);
  assert.equal(readFileSync(join(dir, "routing.jsonl.1"), "utf8").startsWith("xxxx"), true);
  assert.equal(lines(env).length, 1);
  assert.equal(routingLogPath(env), join(dir, "routing.jsonl"));
});

const one = (env) => logRouting("spawn-gate", { input: { session_id: "s" }, toolInput: { subagent_type: "reader" }, outcome: "match", row: null }, env);

test("routing log: a fresh lock held by another hook skips rotation and never replaces the archive", (t) => {
  const { env } = box(t);
  const dir = join(env.XDG_STATE_HOME, "delegation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "routing.jsonl"), `${"x".repeat(MAX_BYTES)}\n`);
  writeFileSync(join(dir, "routing.jsonl.1"), "archive\n");
  writeFileSync(join(dir, "routing.jsonl.lock"), "");
  one(env);
  assert.equal(readFileSync(join(dir, "routing.jsonl.1"), "utf8"), "archive\n");
  assert.ok(readFileSync(join(dir, "routing.jsonl"), "utf8").endsWith('"outcome":"match","description":null}\n'));
  assert.ok(existsSync(join(dir, "routing.jsonl.lock")), "another hook's lock is left alone");
});

test("routing log: a hook that sees a full file another hook already rotated does not rotate again", (t) => {
  const { env } = box(t);
  const dir = join(env.XDG_STATE_HOME, "delegation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "routing.jsonl"), `${"x".repeat(MAX_BYTES)}\n`);
  one(env);
  const archive = readFileSync(join(dir, "routing.jsonl.1"), "utf8");
  one(env);
  one(env);
  assert.equal(readFileSync(join(dir, "routing.jsonl.1"), "utf8"), archive);
  assert.equal(lines(env).length, 3);
  assert.equal(existsSync(join(dir, "routing.jsonl.lock")), false, "the lock is released");
});

test("routing log: a stale lock from a crashed hook is taken over and rotation proceeds", (t) => {
  const { env } = box(t);
  const dir = join(env.XDG_STATE_HOME, "delegation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "routing.jsonl"), `${"x".repeat(MAX_BYTES)}\n`);
  const lock = join(dir, "routing.jsonl.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  utimesSync(lock, old, old);
  one(env);
  assert.equal(readFileSync(join(dir, "routing.jsonl.1"), "utf8").startsWith("xxxx"), true);
  assert.equal(lines(env).length, 1);
  assert.equal(existsSync(lock), false);
});
