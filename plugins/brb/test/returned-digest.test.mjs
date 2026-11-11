// test/returned-digest.test.mjs — the returned digest worked one item at a time, through
// hooks/user-prompt-submit.mjs as a spawned process: `back` lists the items one line each; a
// number (or `brb item N`) shows that item in full; `done N` (or `brb done N`) ticks it and the
// last tick closes the list; `brb clear` shows every item not done in full before the file goes;
// a second hold appends to a list still open; under BRB_HARNESS=omp `back` keeps the whole digest; the words are ordinary prompts with no list open
// or while away. Plus lib/text.mjs digestWord. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { checklistPath, readAway, readChecklist } from "../lib/state.mjs";
import { NO_OPEN_TEXT, digestWord } from "../lib/text.mjs";
import { hold } from "../scripts/brb.mjs";
import { box, promptInput, runHook } from "./helpers.mjs";

const LONG = `Pick Redis or in-process for the cache: ${"the in-process option needs a size bound and an eviction rule, ".repeat(3)}which?`;

/** brb, three held items, back: the box and back's systemMessage. */
function returned() {
  const b = box();
  runHook(b, "user-prompt-submit", promptInput(b, "brb lunch"));
  hold("s1", LONG, { env: b.env });
  hold("s1", "Approve the schema change", { env: b.env });
  hold("s1", "Rotate the staging token", { env: b.env });
  const back = runHook(b, "user-prompt-submit", promptInput(b, "back"));
  assert.equal(back.status, 0);
  return { b, back: back.json.systemMessage };
}

/** A prompt's additionalContext; asserts it passed through (no block). */
function ctx(b, prompt) {
  const r = runHook(b, "user-prompt-submit", promptInput(b, prompt));
  assert.equal(r.status, 0);
  assert.equal(r.json?.decision, undefined, r.stdout);
  return r.json?.hookSpecificOutput?.additionalContext;
}

test("digestWord: numbers, item, done and clear forms; anything longer is not one", () => {
  assert.deepEqual(digestWord(" 2 "), { verb: "show", n: 2, prefixed: false });
  assert.deepEqual(digestWord("#12."), { verb: "show", n: 12, prefixed: false });
  assert.deepEqual(digestWord("BRB item 3"), { verb: "show", n: 3, prefixed: true });
  assert.deepEqual(digestWord("done 2!"), { verb: "done", n: 2, prefixed: false });
  assert.deepEqual(digestWord("brb done #4"), { verb: "done", n: 4, prefixed: true });
  assert.deepEqual(digestWord("brb clear"), { verb: "clear", n: null, prefixed: true });
  for (const t of ["2 more please", "done", "done with 2", "brb", "brb lunch", "clear", "item 2", "12345", "back"]) assert.equal(digestWord(t), null, t);
});

test("back lists every held item one line each, cut at 120 characters, not the bodies", () => {
  const { b, back } = returned();
  try {
    const lines = back.split("\n");
    const list = lines.filter((l) => /^\d+\. /.test(l));
    assert.equal(list.length, 3);
    assert.ok(list[0].startsWith("1. Pick Redis or in-process") && list[0].endsWith("…"), list[0]);
    assert.ok(list[0].length <= 123, `line length ${list[0].length}`);
    assert.equal(list[1], "2. Approve the schema change");
    assert.ok(!back.includes(LONG), "the long item is not shown whole");
    assert.match(back, /Type a number \(1-3\) to open that item/);
    assert.equal(readChecklist("s1", b.env).items.length, 3);
  } finally {
    b.release();
  }
});

test("a bare number, or `brb item N`, makes the agent show that item in full with its heading; nothing changes", () => {
  const { b } = returned();
  try {
    const before = readChecklist("s1", b.env);
    const one = ctx(b, "1");
    assert.match(one, /^brb: Jo opened item 1 of the returned digest\. Start your reply with the item below verbatim/);
    assert.match(one, /do not mark it done yourself/);
    assert.match(one, /\n\nitem 1 of 3 \(held \d{4}-\d\d-\d\d .*\)\n\n/);
    assert.ok(one.endsWith(LONG), "the item in full");
    assert.ok(!one.includes("Approve the schema"), "no other item");
    assert.ok(ctx(b, "brb item 2").endsWith("\n\nApprove the schema change"));
    assert.match(ctx(b, "7"), /^brb: the returned digest has no item 7 \(it has 3, numbered 1-3\)/);
    assert.deepEqual(readChecklist("s1", b.env), before, "showing ticks nothing");
    assert.equal(readAway("s1", b.env), null, "`brb item N` starts no hold");
  } finally {
    b.release();
  }
});

test("`done N` ticks that item and tells the agent what is open; the last tick closes the list; the archive keeps the digest", () => {
  const { b } = returned();
  try {
    assert.match(ctx(b, "done 2"), /^brb: Jo ticked item 2 \(Approve the schema change\) done\. Still open: 1, 3\./);
    assert.deepEqual(readChecklist("s1", b.env).items.map((i) => i.done), [false, true, false]);
    assert.match(ctx(b, "done 2"), /^brb: item 2 .* was already done/);
    assert.match(ctx(b, "brb done 1"), /Still open: 3\./);
    assert.match(ctx(b, "done 3"), /That was the last open item: the returned digest is closed\./);
    assert.equal(existsSync(checklistPath("s1", b.env)), false);
    const archive = join(b.stateDir("s1"), "archive");
    assert.match(b.read(join(archive, readdirSync(archive)[0])), /Rotate the staging token/);
    assert.equal(ctx(b, "done 1"), undefined, "no list open: `done 1` is an ordinary prompt");
  } finally {
    b.release();
  }
});

test("`brb clear` with items not done: every one of them in full, verbatim, the done ones one line each, then the file goes", () => {
  const { b } = returned();
  try {
    ctx(b, "done 2");
    const r = runHook(b, "user-prompt-submit", promptInput(b, "brb clear"));
    const agent = r.json.hookSpecificOutput.additionalContext;
    assert.match(agent, /^brb: Jo closed the returned digest with 2 items not done\. Reply with the block below verbatim as your whole message/);
    assert.ok(agent.endsWith(`\n\n${r.json.systemMessage}`), "the person sees the same block");
    const block = r.json.systemMessage;
    assert.ok(block.includes(`item 1 of 3 (held `) && block.includes(`\n\n${LONG}`), "item 1 in full");
    assert.ok(block.includes("item 3 of 3 (held ") && block.includes("\n\nRotate the staging token"), "item 3 in full");
    assert.match(block, /Done \(1\):\n2\. Approve the schema change$/);
    assert.equal(existsSync(checklistPath("s1", b.env)), false);
    assert.equal(readAway("s1", b.env), null, "`brb clear` starts no hold");
    assert.equal(ctx(b, "brb clear"), NO_OPEN_TEXT, "a second clear finds nothing open");
  } finally {
    b.release();
  }
});

test("no clear path drops an unshown item: an empty hold keeps the open list, a second hold appends to it with numbers and ticks kept", () => {
  const { b } = returned();
  try {
    ctx(b, "done 1");
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    assert.equal(readChecklist("s1", b.env).items.length, 3, "a hold that held nothing leaves the list");
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold("s1", "Merge the docs branch", { env: b.env });
    const back = runHook(b, "user-prompt-submit", promptInput(b, "back")).json.systemMessage;
    assert.match(back, /\n1\. \(done\) Pick Redis.*\n2\. Approve the schema change\n3\. Rotate the staging token\n4\. Merge the docs branch\n/);
    assert.deepEqual(readChecklist("s1", b.env).items.map((i) => [i.text.slice(0, 12), i.done]), [["Pick Redis o", true], ["Approve the ", false], ["Rotate the s", false], ["Merge the do", false]]);
    assert.ok(ctx(b, "4").endsWith("\n\nMerge the docs branch"));
  } finally {
    b.release();
  }
});

test("the words are ordinary prompts with no list open, and while away; the `brb …` forms start no hold", () => {
  const b = box();
  try {
    for (const p of ["2", "done 2"]) assert.equal(runHook(b, "user-prompt-submit", promptInput(b, p)).stdout.trim(), "", `${p} with nothing open`);
    for (const p of ["brb item 2", "brb done 2", "brb clear"]) {
      assert.equal(ctx(b, p), NO_OPEN_TEXT, p);
      assert.equal(readAway("s1", b.env), null, `${p} starts no hold`);
    }
    // An open list, then away: a number is an answer to whatever the agent asked, not a pick.
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold("s1", "Pick a cache", { env: b.env });
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    for (const p of ["1", "done 1"]) assert.match(ctx(b, p), /^brb: still away since /, p);
    assert.equal(readChecklist("s1", b.env).items[0].done, false, "nothing ticked while away");
  } finally {
    b.release();
  }
});

test("under BRB_HARNESS=omp, whose adapter never routes the item words, `back` replies with the whole digest and opens no list", () => {
  const b = box();
  const omp = { env: { BRB_HARNESS: "omp" } };
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"), omp);
    hold("s1", LONG, { env: b.env });
    const back = runHook(b, "user-prompt-submit", promptInput(b, "back"), omp).json;
    assert.match(back.hookSpecificOutput.additionalContext, /^brb: Jo is back .*Reply with the digest below verbatim/);
    assert.ok(back.systemMessage.includes(`- ${LONG}`), "the item in full");
    assert.equal(existsSync(checklistPath("s1", b.env)), false, "no list opened");
    const clear = runHook(b, "user-prompt-submit", promptInput(b, "brb clear"), omp);
    assert.equal(clear.json.decision, "block", "`brb clear` is `brb` with a note, as in 0.5.0");
    assert.equal(readAway("s1", b.env).note, "clear");
  } finally {
    b.release();
  }
});
