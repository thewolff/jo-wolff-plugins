// test/prompt-hook.test.mjs — hooks/user-prompt-submit.mjs as a spawned process with fixture
// stdin: brb (bare and with a note), back, pending, another prompt while away, another prompt
// while home, and the session-start hook while away and home. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AWAY_NOTICE, holdCommand } from "../lib/text.mjs";
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
    assert.equal(ctx.includes(`run ${holdCommand("s1")} once per item`), true, ctx);
    assert.match(ctx, /scripts\/brb\.mjs" hold --session "s1" "<one item, readable on its own>"/);
    assert.match(ctx, /written, not shown/);
    assert.match(ctx, /no `Needs you` section, no question sentence and no closing ask/);
    assert.ok(!/`## Needs you`/.test(ctx), "the old heading instruction is gone");
    assert.match(ctx, /`on fire:`/);
    assert.match(ctx, /`idle: <why>`/);
    assert.match(ctx, /0 items held so far\.$/);
  } finally {
    b.release();
  }
});

test("back and pending while home: pass through (nothing printed), so the word reaches the model as a reply", () => {
  const b = box();
  try {
    for (const w of ["back", "pending", "Back."]) {
      const r = runHook(b, "user-prompt-submit", promptInput(b, w));
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), "", `${w}: ${r.stdout}`);
    }
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
    assert.match(back, /^brb: hold cleared\.\n\nbrb digest — held since .*\n\n\(nothing held\)$/);
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
    assert.equal(stop.json.decision, "block", stop.stdout);
    const peek = blocked(runHook(b, "user-prompt-submit", promptInput(b, "pending")));
    assert.match(peek, /2 items\n\n## .*\n- Pick Redis or in-process\nclosing ask: which\?$/);
    assert.ok(existsSync(join(b.stateDir("s1"), "digest.md")));
    const back = blocked(runHook(b, "user-prompt-submit", promptInput(b, "back")));
    assert.match(back, /^brb: hold cleared; digest archived to .*archive\/.*\.md\.\n\nbrb digest — held since .*, 2 items\n\n## .*\n- Pick Redis or in-process\nclosing ask: which\?$/);
    assert.ok(!existsSync(join(b.stateDir("s1"), "digest.md")));
    assert.ok(!existsSync(join(b.stateDir("s1"), "away.json")));
    const archived = readdirSync(join(b.stateDir("s1"), "archive"));
    assert.equal(archived.length, 1);
    assert.match(b.read(join(b.stateDir("s1"), "archive", archived[0])), /- Pick Redis or in-process/);
  } finally {
    b.release();
  }
});

test("a large digest: back's reason is capped at 8000 characters, the archive path first and again in the cut note", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const asks = Array.from({ length: 300 }, (_, i) => `- Ask ${i}: should the ${"x".repeat(40)} migration use plan ${i}?`).join("\n");
    runHook(b, "stop", { session_id: "s1", cwd: b.work, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: `## Needs you\n${asks}` });
    const peek = blocked(runHook(b, "user-prompt-submit", promptInput(b, "pending")));
    assert.ok(peek.length <= 8000, `pending length ${peek.length}`);
    assert.match(peek, /\n… \(\d+ more lines; full digest: .*digest\.md\)$/);
    const back = blocked(runHook(b, "user-prompt-submit", promptInput(b, "back")));
    assert.ok(back.length <= 8000, `back length ${back.length}`);
    const path = /^brb: hold cleared; digest archived to (.*archive\/.*\.md)\.\n/.exec(back)?.[1];
    assert.ok(path, back.slice(0, 200));
    assert.ok(back.endsWith(`more lines; full digest: ${path})`), back.slice(-200));
    assert.match(b.read(path), /Ask 299:/, "the archive has every line");
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
