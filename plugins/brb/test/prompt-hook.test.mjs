// test/prompt-hook.test.mjs — hooks/user-prompt-submit.mjs as a spawned process with fixture
// stdin: brb (bare and with a note), back, pending, another prompt while away, another prompt
// while home, and the session-start hook while away and home. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AWAY_NOTICE } from "../lib/text.mjs";
import { box, promptInput, runHook } from "./helpers.mjs";

const blocked = (r) => {
  assert.equal(r.status, 0);
  assert.equal(r.json?.decision, "block", r.stdout);
  assert.equal(r.json.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.equal(r.json.hookSpecificOutput?.suppressOriginalPrompt, true);
  return r.json.reason;
};

test("bare brb: blocks the prompt with the confirmation and writes away.json", () => {
  const b = box();
  try {
    const r = runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    assert.equal(blocked(r), AWAY_NOTICE);
    const away = JSON.parse(b.read(join(b.stateDir("s1"), "away.json")));
    assert.match(away.since, /^\d{4}-\d\d-\d\dT/);
    assert.equal(away.note, "");
    assert.equal(away.held, 0);
    assert.equal(b.read(b.errorsLog), "", "no fault logged");
  } finally {
    b.release();
  }
});

test("brb <note>: the note rides the confirmation and the record; a second brb says already away", () => {
  const b = box();
  try {
    const r = runHook(b, "user-prompt-submit", promptInput(b, "brb  lunch, back at 2"));
    assert.equal(blocked(r), `${AWAY_NOTICE} (note: lunch, back at 2)`);
    assert.equal(JSON.parse(b.read(join(b.stateDir("s1"), "away.json"))).note, "lunch, back at 2");
    const again = runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    assert.match(blocked(again), /^brb: already away since .*; 0 held\. Type `back`/);
  } finally {
    b.release();
  }
});

test("another prompt while away: proceeds with the away instruction as additionalContext; while home: nothing", () => {
  const b = box();
  try {
    const home = runHook(b, "user-prompt-submit", promptInput(b, "carry on with the tests"));
    assert.equal(home.status, 0);
    assert.equal(home.stdout.trim(), "", "home prints nothing");
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const away = runHook(b, "user-prompt-submit", promptInput(b, "carry on with the tests"));
    assert.equal(away.status, 0);
    assert.equal(away.json.decision, undefined, "the prompt is not blocked");
    const ctx = away.json.hookSpecificOutput.additionalContext;
    assert.equal(away.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(ctx, /^brb: Jo is away since /);
    assert.match(ctx, /`## Needs you`/);
    assert.match(ctx, /`on fire:`/);
    assert.match(ctx, /`idle: <why>`/);
    assert.match(ctx, /0 items held so far\.$/);
  } finally {
    b.release();
  }
});

test("back and pending while home: blocked, saying nothing is held", () => {
  const b = box();
  try {
    for (const w of ["back", "pending"]) assert.equal(blocked(runHook(b, "user-prompt-submit", promptInput(b, w))), "brb: not away; nothing is held. Type `brb` to start holding.");
    assert.ok(!existsSync(b.stateDir("s1")), "nothing written");
  } finally {
    b.release();
  }
});

test("pending while away with an empty digest: says so and changes nothing; back clears and reports no archive", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const peek = blocked(runHook(b, "user-prompt-submit", promptInput(b, "pending")));
    assert.match(peek, /^brb digest — held since .*, 0 items\n\n\(nothing held\)$/);
    assert.ok(existsSync(join(b.stateDir("s1"), "away.json")), "pending leaves the hold");
    const back = blocked(runHook(b, "user-prompt-submit", promptInput(b, "back")));
    assert.match(back, /\(nothing held\)\n\nbrb: hold cleared\.$/);
    assert.ok(!existsSync(join(b.stateDir("s1"), "away.json")), "back clears the hold");
  } finally {
    b.release();
  }
});

test("back with held items: prints the digest, archives it, clears the hold; pending first leaves it", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const stop = runHook(b, "stop", { session_id: "s1", cwd: b.work, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "## Needs you\n- Pick Redis or in-process\n\nClosing ask: which?" });
    assert.equal(stop.json.decision, "block");
    const peek = blocked(runHook(b, "user-prompt-submit", promptInput(b, "pending")));
    assert.match(peek, /1 item\n\n## .*\n- Pick Redis or in-process\nclosing ask: which\?$/);
    assert.ok(existsSync(join(b.stateDir("s1"), "digest.md")));
    const back = blocked(runHook(b, "user-prompt-submit", promptInput(b, "back")));
    assert.match(back, /^brb digest — held since .*, 1 item\n\n## .*\n- Pick Redis or in-process\nclosing ask: which\?\n\nbrb: hold cleared; digest archived to .*archive\/.*\.md\.$/);
    assert.ok(!existsSync(join(b.stateDir("s1"), "digest.md")));
    assert.ok(!existsSync(join(b.stateDir("s1"), "away.json")));
    const archived = readdirSync(join(b.stateDir("s1"), "archive"));
    assert.equal(archived.length, 1);
    assert.match(b.read(join(b.stateDir("s1"), "archive", archived[0])), /- Pick Redis or in-process/);
  } finally {
    b.release();
  }
});

test("session-start: the instruction and a line for the person while away; nothing while home", () => {
  const b = box();
  try {
    const home = runHook(b, "session-start", { session_id: "s1", cwd: b.work, hook_event_name: "SessionStart", source: "resume" });
    assert.equal(home.status, 0);
    assert.equal(home.stdout.trim(), "");
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const away = runHook(b, "session-start", { session_id: "s1", cwd: b.work, hook_event_name: "SessionStart", source: "resume" });
    assert.equal(away.status, 0);
    assert.match(away.json.systemMessage, /^brb: away since .*; 0 held\. Type `back` to read them\.$/);
    assert.equal(away.json.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(away.json.hookSpecificOutput.additionalContext, /^brb: Jo is away since /);
  } finally {
    b.release();
  }
});

test("a prompt with no session id still works, under the no-session key", () => {
  const b = box();
  try {
    const r = runHook(b, "user-prompt-submit", { prompt: "brb" });
    assert.equal(blocked(r), AWAY_NOTICE);
    assert.ok(existsSync(join(b.stateDir("no-session"), "away.json")));
  } finally {
    b.release();
  }
});
