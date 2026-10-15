import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import askGrahamOmp from "./ask-graham-omp.ts";
import { NUDGE } from "../skills/ask-graham/scripts/intensity.mjs";
import { BLOCK_REASON } from "../skills/ask-graham/scripts/verdict.mjs";
import { omp } from "../fixtures/transcripts.mjs";

const EXPECTED = { message: { customType: "ask-graham", content: NUDGE, display: false } };

function fixture(t, env) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ask-graham-omp-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const xdg = join(base, "xdg");
  const repo = join(base, "repo");
  mkdirSync(join(xdg, "ask-graham"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  const handlers = {};
  const pi = { on: (event, h) => { handlers[event] = h; } };
  askGrahamOmp(pi, { env: env ?? { XDG_CONFIG_HOME: xdg }, home: base });
  const start = () =>
    handlers.before_agent_start(
      { type: "before_agent_start", prompt: "what if we built a thing", systemPrompt: [] },
      { cwd: repo },
    );
  return { base, xdg, repo, start, handlers };
}

test("registers a before_agent_start and a session_stop handler", (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.handlers).sort(), ["before_agent_start", "session_stop"]);
});

test("at ask the turn gets no message", (t) => {
  const f = fixture(t);
  assert.equal(f.start(), undefined);
});

test("at every-idea the turn gets the nudge as one hidden message, the same on a re-run", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  const first = f.start();
  assert.deepEqual(first, EXPECTED);
  // OMP may run the chain more than once for one submission; each run must give the same message.
  assert.deepEqual(f.start(), first);
});

test("a repo file at ask wins over a user file at every-idea", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "intensity=every-idea\n");
  writeFileSync(join(f.repo, ".ask-graham"), "intensity=ask\n");
  assert.equal(f.start(), undefined);
});

test("a setting that cannot be resolved fails open with no message", (t) => {
  const env = {
    get XDG_CONFIG_HOME() {
      throw new Error("environment unreadable");
    },
  };
  const f = fixture(t, env);
  assert.equal(f.start(), undefined);
});

// --- session_stop: the Stop check ----------------------------------------------------------------

const ANSWER = "Searched the repo; nothing like it exists.";

// An ask-graham turn: a prompt, a read of the skill, and an answer with no verdict.
const askGrahamTurn = (s) => {
  s.prompt("should we build a cache?");
  s.read("skill://ask-graham");
  s.say(ANSWER);
};

// One OMP session file built by `build`, and a stop() that fires session_stop on it. Each call
// gets its own session id: the once-per-turn record is per process.
function stopFixture(t, build = askGrahamTurn) {
  const f = fixture(t);
  const s = omp();
  build(s);
  const file = join(f.base, "session.jsonl");
  const save = () => writeFileSync(file, s.jsonl());
  save();
  const id = randomUUID();
  const ctx = { cwd: f.repo, sessionManager: { getSessionId: () => id } };
  const stop = (event = {}, c = ctx) =>
    f.handlers.session_stop(
      { session_id: "provider-id", session_file: file, stop_hook_active: false, last_assistant_message: { role: "assistant", content: [{ type: "text", text: ANSWER }] }, ...event },
      c,
    );
  return { ...f, s, file, save, stop, ctx };
}

const BLOCK = { decision: "block", reason: BLOCK_REASON };
const said = (text) => ({ last_assistant_message: { role: "assistant", content: [{ type: "text", text }] } });

test("session_stop blocks a turn that read the skill without a verdict", (t) => {
  const f = stopFixture(t);
  assert.deepEqual(f.stop(), BLOCK);
});

test("session_stop with stop-check=off in the user file passes and records no block; on blocks", (t) => {
  const f = stopFixture(t);
  const userFile = join(f.xdg, "ask-graham", "config");
  writeFileSync(userFile, "intensity=every-idea\nstop-check=off\n");
  assert.equal(f.stop(), undefined);
  assert.equal(f.stop(), undefined);
  // Nothing was recorded while off, so turning it back on blocks this same turn.
  writeFileSync(userFile, "stop-check=on\n");
  assert.deepEqual(f.stop(), BLOCK);
});

test("session_stop with stop-check=off in a .ask-graham above the cwd wins over the user file", (t) => {
  const f = stopFixture(t);
  writeFileSync(join(f.xdg, "ask-graham", "config"), "stop-check=on\n");
  writeFileSync(join(f.repo, ".ask-graham"), "intensity=ask\nstop-check=off\n");
  assert.equal(f.stop(), undefined);
  writeFileSync(join(f.repo, ".ask-graham"), "intensity=ask\n");
  assert.deepEqual(f.stop(), BLOCK);
});

test("session_stop passes each verdict, as text blocks or a string", (t) => {
  const f = stopFixture(t);
  for (const v of ["do it now", "start now", "later", "don't build", "don’t build"]) {
    assert.equal(f.stop(said(`${ANSWER}\n\n**Verdict:** ${v}`)), undefined, v);
    assert.equal(f.stop({ last_assistant_message: { role: "assistant", content: `**Verdict:** ${v}` } }), undefined, v);
  }
  assert.deepEqual(f.stop(said(`${ANSWER}\n\n**Verdict:** backlog`)), BLOCK);
});

test("session_stop falls back to the session file's last assistant text when the event has none", (t) => {
  const f = stopFixture(t, (s) => {
    s.prompt("should we build a cache?");
    s.read("skill://ask-graham");
    s.say("**Verdict:** later");
  });
  assert.equal(f.stop({ last_assistant_message: undefined }), undefined);
});

test("session_stop blocks once per turn: the next stop in the turn passes, a new turn is checked again", (t) => {
  const f = stopFixture(t);
  assert.deepEqual(f.stop(), BLOCK);
  f.s.continuation(BLOCK_REASON);
  f.s.say("Still thinking.");
  f.save();
  assert.equal(f.stop({ stop_hook_active: true }), undefined);
  f.s.prompt("and should we build a queue?");
  f.s.read("skill://ask-graham");
  f.s.say(ANSWER);
  f.save();
  assert.deepEqual(f.stop({ stop_hook_active: true }), BLOCK);
});

test("session_stop with stop_hook_active true but no block of its own still blocks", (t) => {
  const f = stopFixture(t);
  f.s.continuation("another extension's reason");
  f.s.say("Handled the other extension.");
  f.save();
  assert.deepEqual(f.stop({ stop_hook_active: true }), BLOCK);
});

test("session_stop keys the record on the session manager id, else the payload id", (t) => {
  const f = stopFixture(t);
  assert.deepEqual(f.stop(), BLOCK);
  // Another session (another manager id) on the same file is checked on its own.
  assert.deepEqual(f.stop({}, { cwd: f.repo, sessionManager: { getSessionId: () => randomUUID() } }), BLOCK);
  // With no readable manager id, the payload's session_id is the key.
  const lost = { cwd: f.repo, sessionManager: { getSessionId: () => { throw new Error("gone"); } } };
  const pid = randomUUID();
  assert.deepEqual(f.stop({ session_id: pid }, lost), BLOCK);
  assert.equal(f.stop({ session_id: pid }, lost), undefined);
});

test("session_stop passes a /skill:ask-graham intensity turn, blocks a mid-prompt /skill: check", (t) => {
  const a = stopFixture(t, (s) => {
    s.skillPrompt("ask-graham", "intensity");
    s.bash("node /plugins/ask-graham/skills/ask-graham/scripts/intensity.mjs");
  });
  assert.equal(a.stop(said("Intensity is ask (default).")), undefined);

  const b = stopFixture(t, (s) => s.skillPrompt("ask-graham", "should we build a cache", "should we build /skill:ask-graham a cache"));
  assert.deepEqual(b.stop(), BLOCK);
});

test("session_stop passes a turn with no skill read", (t) => {
  const f = stopFixture(t, (s) => {
    s.prompt("fix the login bug");
    s.say("Fixed.");
  });
  assert.equal(f.stop(said("Fixed.")), undefined);
});

test("session_stop fails open on a missing, unreadable or absent session file", (t) => {
  const f = stopFixture(t);
  for (const session_file of [join(f.base, "nope.jsonl"), f.base, "", undefined, 7]) {
    assert.equal(f.stop({ session_file }), undefined, String(session_file));
  }
  assert.equal(f.handlers.session_stop(undefined, f.ctx), undefined);
});

test("session_stop passes the comparables question from the event or transcript without consuming the block", (t) => {
  const question = "Do you want me to research and see if something comparable exists?";
  const f = stopFixture(t);
  assert.equal(f.stop(said(question)), undefined);
  f.s.say(question);
  f.save();
  assert.equal(f.stop({ last_assistant_message: undefined }), undefined);
  assert.deepEqual(f.stop(said(ANSWER)), BLOCK);
});
