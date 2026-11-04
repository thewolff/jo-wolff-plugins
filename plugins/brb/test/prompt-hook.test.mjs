// test/prompt-hook.test.mjs — hooks/user-prompt-submit.mjs as a spawned process with fixture
// stdin: brb (bare and with a note), back (through, with the digest as additionalContext and a
// systemMessage; any case), pending, another prompt while away, another prompt while home, and
// the session-start hook while away and home. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AWAY_NOTICE, NOT_AWAY_TEXT, awayFor, awayInstruction, hasReplyFirstLine, holdCommand, replyFirstLine } from "../lib/text.mjs";
import { box, promptInput, runHook } from "./helpers.mjs";

const blocked = (r) => {
  assert.equal(r.status, 0);
  assert.equal(r.json?.decision, "block", r.stdout);
  assert.equal(r.json.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.equal(r.json.hookSpecificOutput?.suppressOriginalPrompt, true);
  return r.json.reason;
};
/** `back`'s answer: no block, the digest as a systemMessage and, under the back instruction, as additionalContext. Returns the systemMessage. */
const cameBack = (r) => {
  assert.equal(r.status, 0);
  assert.equal(r.json?.decision, undefined, r.stdout);
  assert.equal(r.json.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.equal(r.json.hookSpecificOutput?.suppressOriginalPrompt, undefined, "not a block");
  const ctx = r.json.hookSpecificOutput?.additionalContext;
  assert.match(ctx, /^brb: Jo is back(?: \(away \d+m\))?\. Reply with the digest below verbatim as your whole message, then stop \(end with nothing else\)\. If a held item is already resolved, append '— resolved: <how>' to that line\.\n\n/);
  assert.ok(ctx.endsWith(`\n\n${r.json.systemMessage}`), "the context carries the same text as the systemMessage");
  assert.ok(ctx.length <= 10_000, `additionalContext length ${ctx.length} (Claude Code caps it at 10,000)`);
  return r.json.systemMessage;
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

test("brb <note>: the note rides the confirmation and the record; a second brb passes through saying the hold is still on", () => {
  const b = box();
  try {
    const r = runHook(b, "user-prompt-submit", promptInput(b, "brb  lunch, back at 2"));
    assert.equal(blocked(r), `${AWAY_NOTICE} (note: lunch, back at 2)`);
    const awayPath = join(b.stateDir("s1"), "away.json");
    assert.equal(JSON.parse(b.read(awayPath)).note, "lunch, back at 2");
    const before = b.read(awayPath);
    const again = runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    assert.equal(again.status, 0);
    assert.equal(again.json.decision, undefined, "not blocked: the agent is re-armed");
    const line = /^brb: still away since \S+ \(0m\); 0 held\. Only `back` ends the hold; `pending` peeks\. Your questions answered while away did not end it\.$/;
    assert.match(again.json.systemMessage, line);
    const ctx = again.json.hookSpecificOutput.additionalContext;
    assert.equal(again.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(ctx.startsWith(`${again.json.systemMessage}\n\nbrb: still away since `), ctx);
    assert.equal(b.read(awayPath), before, "a second brb changes nothing");
  } finally {
    b.release();
  }
});

test("a fire answered does not end the hold: a normal prompt while away leaves away.json unchanged and re-arms the agent", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const awayPath = join(b.stateDir("s1"), "away.json");
    const before = b.read(awayPath);
    const reply = runHook(b, "user-prompt-submit", promptInput(b, "revert the push, then carry on"));
    assert.equal(reply.json.decision, undefined);
    const ctx = reply.json.hookSpecificOutput.additionalContext;
    assert.match(ctx.split("\n")[0], /^brb: still away since \S+ \(0m\); 0 held$/);
    assert.match(ctx, /^6\. A fire answered does not end the hold\. .*Jo's reply is not `back`; only the prompt `back` on its own ends the hold\.$/m);
    assert.equal(b.read(awayPath), before, "away.json untouched");
  } finally {
    b.release();
  }
});

test("the instruction's live values: duration since `since`, the reply's first line with count, a note on line 2", () => {
  const away = { since: "2026-11-04T10:00:00.000Z", note: "lunch", held: 2 };
  const ctx = awayInstruction(away, holdCommand("s1"), "2026-11-04T11:05:00.000Z").split("\n");
  assert.equal(ctx[0], "brb: still away since 2026-11-04T10:00:00.000Z (1h 5m); 2 held");
  assert.equal(ctx[1], "Jo is away (lunch). Keep working; do not stop to wait for an answer.");
  assert.equal(ctx[7], "5. Start every reply with this line, as its first line: brb: still away (1h 5m, 2 held) — say `back` to read them. A Stop hook sends a reply without it back once.");
  assert.equal(replyFirstLine({ since: "bad", held: 0 }, "2026-11-04T11:05:00.000Z"), "brb: still away (0 held) — say `back` to read them");
  assert.equal(awayFor("2026-11-04T10:00:00.000Z", "2026-11-04T10:40:30.000Z"), "40m");
  assert.equal(awayFor("2026-11-04T10:00:00.000Z", "2026-11-06T13:00:00.000Z"), "2d 3h");
  assert.equal(awayFor("2026-11-04T10:00:00.000Z", "2026-11-04T09:00:00.000Z"), "0m");
  assert.equal(awayFor("x", "2026-11-04T09:00:00.000Z"), "");
  for (const ok of ["brb: still away (5m, 0 held) — say `back` to read them\nDid it.", "\n> **brb: still away (5m, 0 held)**\nDid it.", "`brb: still away (1 held)`"]) assert.equal(hasReplyFirstLine(ok), true, ok);
  for (const no of ["Did it.\nbrb: still away (5m, 0 held)", "", "brb: away"]) assert.equal(hasReplyFirstLine(no), false, no);
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
    assert.match(ctx, /^brb: still away since /);
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

test("pending while home passes through (nothing printed); back while home passes through saying nothing was held, so the word reaches the model as a reply", () => {
  const b = box();
  try {
    const r = runHook(b, "user-prompt-submit", promptInput(b, "pending"));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "", r.stdout);
    for (const w of ["back", "Back.", "BACK"]) {
      const home = runHook(b, "user-prompt-submit", promptInput(b, w));
      assert.equal(home.status, 0);
      assert.deepEqual(home.json, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NOT_AWAY_TEXT } }, `${w}: ${home.stdout}`);
    }
    assert.ok(!existsSync(b.stateDir("s1")), "nothing written");
  } finally {
    b.release();
  }
});

test("back in any case or with a trailing mark (Back, back., BACK) ends the hold and answers the digest", () => {
  const b = box();
  try {
    for (const w of ["Back", "back.", "BACK"]) {
      runHook(b, "user-prompt-submit", promptInput(b, "brb"));
      assert.match(cameBack(runHook(b, "user-prompt-submit", promptInput(b, w))), /^brb: hold cleared\.\n\nbrb digest — held since/, w);
      assert.ok(!existsSync(join(b.stateDir("s1"), "away.json")), `${w} clears the hold`);
    }
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
    const back = cameBack(runHook(b, "user-prompt-submit", promptInput(b, "back")));
    assert.match(back, /^brb: hold cleared\.\n\nbrb digest — held since .*\n\n\(nothing held\)$/);
    assert.ok(!existsSync(join(b.stateDir("s1"), "away.json")), "back clears the hold");
  } finally {
    b.release();
  }
});

test("back with held items: answers the digest (for the agent to reply with, and as a systemMessage), archives it, clears the hold; pending first leaves it", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const stop = runHook(b, "stop", { session_id: "s1", cwd: b.work, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "## Needs you\n- Pick Redis or in-process\n\nClosing ask: which?" });
    assert.equal(stop.json.decision, "block", stop.stdout);
    const peek = blocked(runHook(b, "user-prompt-submit", promptInput(b, "pending")));
    assert.match(peek, /2 items\n\n## .*\n- Pick Redis or in-process\nclosing ask: which\?$/);
    assert.ok(existsSync(join(b.stateDir("s1"), "digest.md")));
    const back = cameBack(runHook(b, "user-prompt-submit", promptInput(b, "back")));
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

test("a large digest: back's text is capped at 8000 characters (the context under 10,000), the archive path first and again in the cut note", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    const asks = Array.from({ length: 300 }, (_, i) => `- Ask ${i}: should the ${"x".repeat(40)} migration use plan ${i}?`).join("\n");
    runHook(b, "stop", { session_id: "s1", cwd: b.work, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: `## Needs you\n${asks}` });
    const peek = blocked(runHook(b, "user-prompt-submit", promptInput(b, "pending")));
    assert.ok(peek.length <= 8000, `pending length ${peek.length}`);
    assert.match(peek, /\n… \(\d+ more lines; full digest: .*digest\.md\)$/);
    const back = cameBack(runHook(b, "user-prompt-submit", promptInput(b, "back")));
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
    assert.match(away.json.hookSpecificOutput.additionalContext, /^brb: still away since /);
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
