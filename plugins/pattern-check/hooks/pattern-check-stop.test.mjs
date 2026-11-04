import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle } from "./pattern-check-stop.mjs";
import { paths, stateDir } from "../scripts/lib/state.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "pattern-check-stop.mjs");
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "pattern-check.mjs");
const SESSION = "0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10";
const PLAN = "## Plan\n1. Add a config loader in src/config/\n2. Add a retry helper\n3. Wire both into the router";
const REPORT = "Done. Tests pass 12/12; the two files changed are listed below.";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pattern-check-stop-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = join(base, "state");
  const config = join(base, "config");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: config, CLAUDE_PLUGIN_ROOT: dirname(dirname(HOOK)) };
  const sd = stateDir(env, base);
  const payload = (message = PLAN, extra = {}) => ({ hook_event_name: "Stop", session_id: SESSION, cwd: repo, stop_hook_active: false, last_assistant_message: message, ...extra });
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, HOME: base, ...env }, encoding: "utf8", timeout: 5000 });
  const call = (input) => handle(input, { env, home: base });
  const setUser = (text) => { mkdirSync(join(config, "pattern-check"), { recursive: true }); writeFileSync(join(config, "pattern-check", "config.json"), text); };
  const record = () => spawnSync(process.execPath, [CLI, "record", "--session", SESSION, "--cwd", repo, "--no-new-pieces", "test"], { env: { ...process.env, HOME: base, ...env }, encoding: "utf8", timeout: 5000 });
  return { base, state, repo, env, sd, payload, run, call, setUser, record };
}

test("a reply that proposes a plan with no receipt is refused, and the reason names the record command with --session", (t) => {
  const f = fixture(t);
  const out = f.call(f.payload());
  assert.equal(out.decision, "block");
  assert.match(out.reason, /^pattern-check: this reply proposes a plan or design \(heading: ## Plan\)/);
  assert.ok(out.reason.includes(`node "${CLI}" record --session ${SESSION} < table.md`), out.reason);
  assert.ok(out.reason.includes(`--no-new-pieces "<reason>"`), out.reason);
  // Both questions, in so many words.
  assert.ok(out.reason.includes("what exists already"), out.reason);
  assert.ok(out.reason.includes("how does it fail"), out.reason);
});

test("end to end through stdin: exit 0 and the block JSON", (t) => {
  const f = fixture(t);
  const r = f.run(f.payload());
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, "block");
});

test("with a receipt the same reply passes", (t) => {
  const f = fixture(t);
  assert.equal(f.record().status, 0);
  assert.equal(f.call(f.payload()), null);
  assert.equal(f.run(f.payload()).stdout, "");
});

test("a reply that does not propose passes; a missing last_assistant_message passes", (t) => {
  const f = fixture(t);
  assert.equal(f.call(f.payload(REPORT)), null);
  const noMessage = f.payload();
  delete noMessage.last_assistant_message;
  assert.equal(f.call(noMessage), null);
});

test("stop_hook_active true passes, so a continuation after any stop hook is never refused again", (t) => {
  const f = fixture(t);
  assert.equal(f.call(f.payload(PLAN, { stop_hook_active: true })), null);
});

test("the loop guard: the same reply is refused once; a different plan is refused again", (t) => {
  const f = fixture(t);
  assert.equal(f.call(f.payload()).decision, "block");
  assert.equal(f.call(f.payload()), null);
  assert.equal(f.call(f.payload("**Verdict:** start now. Waiting blocks the release.")).decision, "block");
});

test("hooks.stop false switches the hook off", (t) => {
  const f = fixture(t);
  f.setUser(JSON.stringify({ hooks: { stop: false } }));
  assert.equal(f.call(f.payload()), null);
});

test("fail open: a corrupt config warns and still refuses under the defaults; an unwritable state passes with a warning; garbage stdin passes", (t) => {
  const f = fixture(t);
  f.setUser("{ torn");
  const out = f.call(f.payload());
  assert.equal(out.decision, "block");
  assert.match(out.systemMessage, /not valid JSON/);
  // The refusal record cannot be written: pass rather than loop.
  writeFileSync(join(f.base, "state-file"), "");
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(f.payload("**Verdict:** later.")), env: { ...process.env, HOME: f.base, ...f.env, XDG_STATE_HOME: join(f.base, "state-file") }, encoding: "utf8" });
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.equal(o.decision, undefined);
  assert.match(o.systemMessage, /could not record the refusal/);
  assert.equal(f.run("not json").status, 0);
});

test("a missing session_id degrades to a per-cwd key: still refused, with a warning, and the receipt for that key lifts it", (t) => {
  const f = fixture(t);
  const p = f.payload();
  delete p.session_id;
  const out = f.call(p);
  assert.equal(out.decision, "block");
  assert.match(out.systemMessage, /no usable session_id/);
  const key = out.reason.match(/--session (cwd-[0-9a-f]{16})/)[1];
  const rec = spawnSync(process.execPath, [CLI, "record", "--session", key, "--cwd", f.repo, "--no-new-pieces", "x"], { env: { ...process.env, HOME: f.base, ...f.env }, encoding: "utf8" });
  assert.equal(rec.status, 0, rec.stderr);
  const after = f.call({ ...p, last_assistant_message: "## Design\nanother" });
  assert.equal(after.decision, undefined);
  assert.match(after.systemMessage, /no usable session_id/);
  assert.equal(paths.stop(f.sd, key).endsWith(key), true);
});

test("process: empty stdin, malformed JSON and a non-object payload exit 0, let the stop through, warn, and log to errors.log", (t) => {
  const f = fixture(t);
  for (const [input, re] of [["", /got empty stdin/], ["{ torn", /got stdin that is not JSON/], ["42", /not a JSON object/]]) {
    const r = f.run(input);
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, re);
    assert.match(out.systemMessage, /the stop was allowed$/);
  }
  const log = readFileSync(join(f.sd, "errors.log"), "utf8").trimEnd().split("\n");
  assert.equal(log.length, 3);
  for (const l of log) assert.match(l, /^\S+Z pattern-check-stop\.mjs the Stop hook got /);
});

test("process: a missing config refuses under the defaults with no warning; the refusal is not an error and is not logged", (t) => {
  const f = fixture(t);
  const r = f.run(f.payload());
  assert.equal(r.error, undefined, String(r.error));
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.equal(out.systemMessage, undefined);
  assert.equal(existsSync(join(f.sd, "errors.log")), false);
});
