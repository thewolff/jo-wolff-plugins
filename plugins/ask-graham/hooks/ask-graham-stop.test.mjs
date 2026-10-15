import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blockedDir, handle } from "./ask-graham-stop.mjs";
import { BLOCK_REASON } from "../skills/ask-graham/scripts/verdict.mjs";
import { claudeCode } from "../fixtures/transcripts.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "ask-graham-stop.mjs");
const SESSION = "0b0e6a1c-5d2f-4c1e-9a77-3f0e2c1d9b10";

// A temp HOME, XDG_STATE_HOME and XDG_CONFIG_HOME, a working directory with no .ask-graham above it
// (the temp dir), and a transcript of one ask-graham turn ending in `reply`.
function fixture(t, reply = "Searched the repo; nothing like it exists.") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-stop-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = join(base, "state");
  const config = join(base, "config");
  const env = { XDG_STATE_HOME: state, XDG_CONFIG_HOME: config };
  const setUser = (text) => { mkdirSync(join(config, "ask-graham"), { recursive: true }); writeFileSync(join(config, "ask-graham", "config"), text); };
  const cc = claudeCode();
  const opener = cc.prompt("should we build a cache?");
  cc.skill("ask-graham:ask-graham", "should we build a cache");
  cc.say(reply);
  const transcript = join(base, "transcript.jsonl");
  const save = () => writeFileSync(transcript, cc.jsonl());
  save();
  const payload = (extra = {}) => ({ hook_event_name: "Stop", session_id: SESSION, transcript_path: transcript, cwd: base, stop_hook_active: false, ...extra });
  const record = join(state, "ask-graham", "blocked", SESSION);
  const run = (input, envOverride = {}) =>
    spawnSync(process.execPath, [HOOK], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      env: { ...process.env, HOME: base, XDG_STATE_HOME: state, XDG_CONFIG_HOME: config, ...envOverride },
      encoding: "utf8",
    });
  return { base, state, env, cc, opener, transcript, save, payload, record, run, setUser };
}

test("stop-check=off in the user file: no block, no record; on or absent blocks", (t) => {
  const f = fixture(t);
  f.setUser("intensity=ask\n");
  assert.equal(f.run(f.payload()).stdout !== "", true);
  rmSync(f.record);
  f.setUser("stop-check=off\n");
  const off = f.run(f.payload());
  assert.equal(off.status, 0);
  assert.equal(off.stdout, "");
  assert.equal(existsSync(f.record), false);
  f.setUser("stop-check=on\n");
  assert.deepEqual(JSON.parse(f.run(f.payload()).stdout), { decision: "block", reason: BLOCK_REASON });
});

test("stop-check=off in a .ask-graham above the payload's cwd wins over the user file", (t) => {
  const f = fixture(t);
  f.setUser("stop-check=on\n");
  const repo = join(f.base, "repo");
  const sub = join(repo, "src");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(repo, ".ask-graham"), "stop-check=off\n");
  assert.equal(handle(f.payload({ cwd: sub }), { env: f.env, home: f.base }), null);
  assert.equal(handle(f.payload(), { env: f.env, home: f.base })?.decision, "block");
});

test("end to end: a turn that read the skill with no verdict is blocked once, and the block is recorded", (t) => {
  const f = fixture(t);
  const r = f.run(f.payload());
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { decision: "block", reason: BLOCK_REASON });
  assert.equal(readFileSync(f.record, "utf8"), `${f.opener}\n`);

  // Claude Code continues the turn; the next stop in the same turn passes even without a verdict.
  f.cc.stopSummary();
  f.cc.say("Still no verdict.");
  f.save();
  const again = f.run(f.payload({ stop_hook_active: true }));
  assert.equal(again.status, 0);
  assert.equal(again.stdout, "");
});

test("end to end: a reply with a verdict passes and records nothing", (t) => {
  const f = fixture(t, "Nothing like it exists.\n\n**Verdict:** don’t build");
  const r = f.run(f.payload());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(f.record), false);
});

test("stop_hook_active true with no block of its own still blocks", (t) => {
  const f = fixture(t);
  assert.deepEqual(handle(f.payload({ stop_hook_active: true }), { env: f.env, home: f.base }), { decision: "block", reason: BLOCK_REASON });
});

test("a block recorded for an earlier turn does not let this turn through", (t) => {
  const f = fixture(t);
  mkdirSync(dirname(f.record), { recursive: true });
  writeFileSync(f.record, "cc-earlier-turn\n");
  assert.equal(handle(f.payload(), { env: f.env, home: f.base })?.decision, "block");
  assert.equal(readFileSync(f.record, "utf8"), `${f.opener}\n`);
});

test("intensity invocation passes", (t) => {
  const f = fixture(t);
  const cc = claudeCode();
  cc.slash("ask-graham:ask-graham", "intensity every-idea");
  cc.bash("node /plugins/ask-graham/skills/ask-graham/scripts/intensity.mjs every-idea");
  cc.say("Intensity is now every-idea.");
  writeFileSync(f.transcript, cc.jsonl());
  assert.equal(handle(f.payload(), { env: f.env, home: f.base }), null);
});

test("a torn last line is skipped, not fatal", (t) => {
  const f = fixture(t);
  writeFileSync(f.transcript, `${f.cc.jsonl()}{"type":"assistant","uuid":"torn`);
  assert.equal(handle(f.payload(), { env: f.env, home: f.base })?.decision, "block");
});

test("a missing or unreadable transcript fails open", (t) => {
  const f = fixture(t);
  for (const transcript_path of [join(f.base, "nope.jsonl"), f.base, "", undefined]) {
    assert.equal(handle(f.payload({ transcript_path }), { env: f.env, home: f.base }), null, String(transcript_path));
  }
  const r = f.run(f.payload({ transcript_path: join(f.base, "nope.jsonl") }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("a session id that is not a plain file name fails open", (t) => {
  const f = fixture(t);
  for (const session_id of ["../escape", "", undefined, 42]) {
    assert.equal(handle(f.payload({ session_id }), { env: f.env, home: f.base }), null, String(session_id));
  }
});

test("an unwritable state directory fails open rather than block without a record", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.base, "file"), "");
  assert.equal(handle(f.payload(), { env: { XDG_STATE_HOME: join(f.base, "file") }, home: f.base }), null);
});

test("garbage on stdin exits 0 with nothing on stdout", (t) => {
  const f = fixture(t);
  const r = f.run("not json");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("the record lives under XDG_STATE_HOME only when it is absolute", () => {
  assert.equal(blockedDir({ XDG_STATE_HOME: "/x/state" }, "/home/me"), "/x/state/ask-graham/blocked");
  assert.equal(blockedDir({ XDG_STATE_HOME: "rel/state" }, "/home/me"), "/home/me/.local/state/ask-graham/blocked");
  assert.equal(blockedDir({}, "/home/me"), "/home/me/.local/state/ask-graham/blocked");
});

test("end to end: with a relative XDG_STATE_HOME the record goes under HOME", (t) => {
  const f = fixture(t);
  const r = f.run(f.payload(), { XDG_STATE_HOME: "relative" });
  assert.equal(JSON.parse(r.stdout).decision, "block");
  assert.ok(existsSync(join(f.base, ".local", "state", "ask-graham", "blocked", SESSION)));
});

test("end to end: waiting for comparables passes without consuming the turn's block", (t) => {
  const f = fixture(t, "Do you want me to research and see if something comparable exists?");
  const r = f.run(f.payload());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(f.record), false);
  f.cc.say("Finished the check without a verdict.");
  f.save();
  assert.deepEqual(JSON.parse(f.run(f.payload()).stdout), { decision: "block", reason: BLOCK_REASON });
});
