// test/returned-digest.test.mjs — the returned digest worked one item at a time, through
// hooks/user-prompt-submit.mjs as a spawned process: `back` lists the items one line each; a
// number (or `brb item N`) shows that item in full; `done N` (or `brb done N`) ticks it and the
// last tick closes the list; `brb clear` shows every item not done in full before the file goes;
// a second hold appends to a list still open; under BRB_HARNESS=omp `back` keeps the whole digest; the words are ordinary prompts with no list open
// or while away. Too long for the context: `brb clear` and one item are exported whole first, and a
// failed export keeps the list; a `back` whose checklist write failed loses nothing on retry.
// Plus lib/text.mjs digestWord. node --test.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The context limit the reviewer named for additionalContext; brb's own cap (REASON_CAP) sits under it. */
const CONTEXT_LIMIT = 10_000;
/** One held item far past the cap, with a marker at its end. */
const HUGE = (tag) => `${tag}: ${"a long held paragraph that runs past what one hook context carries, ".repeat(160)}END-${tag}`;

test("`brb clear` past the cap: the whole block goes to an export first, the text points at it, then the list goes; a failed export removes nothing", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    for (const t of ["one", "two", "three"]) hold("s1", HUGE(t), { env: b.env });
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    // A failed export: a file where the export directory goes.
    writeFileSync(join(b.stateDir("s1"), "export"), "not a directory");
    const kept = runHook(b, "user-prompt-submit", promptInput(b, "brb clear"));
    assert.equal(kept.status, 0);
    assert.match(kept.json.systemMessage, /^brb: the returned digest was not closed\. .*could not be written \(.*\)\. Nothing was removed/);
    assert.match(kept.json.hookSpecificOutput.additionalContext, /^brb: Jo typed `brb clear`, but the returned digest stays open/);
    assert.equal(readChecklist("s1", b.env).items.length, 3, "the list stays when its export fails");
    // The export can be written: every open item in full in the file, the text cut and pointing at it.
    rmSyncFile(join(b.stateDir("s1"), "export"));
    const r = runHook(b, "user-prompt-submit", promptInput(b, "brb clear"));
    const agent = r.json.hookSpecificOutput.additionalContext;
    assert.ok(agent.length < CONTEXT_LIMIT && r.json.systemMessage.length < CONTEXT_LIMIT, `context ${agent.length}`);
    const m = /the whole text: (\/[^)]+\.md)\)$/.exec(r.json.systemMessage);
    assert.ok(m, r.json.systemMessage.slice(-200));
    const file = readFileSync(m[1], "utf8");
    for (const t of ["one", "two", "three"]) assert.ok(file.includes(HUGE(t)), `item ${t} whole in the export`);
    assert.ok(!r.json.systemMessage.includes("END-three"), "the text itself is cut");
    assert.ok(agent.includes(m[1]), "the agent is told the export path");
    assert.equal(existsSync(checklistPath("s1", b.env)), false, "the list goes once the export holds it");
  } finally {
    b.release();
  }
});

test("a `back` whose checklist write fails fails open, keeps the hold and the digest, and the retry lists every item; a failed archive step is not doubled", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    for (const t of ["Approve the schema change", "Rotate the staging token"]) hold("s1", t, { env: b.env });
    // checklist.json as a non-empty directory: the rename onto it fails.
    const list = checklistPath("s1", b.env);
    mkdirSync(join(list, "x"), { recursive: true });
    const failed = runHook(b, "user-prompt-submit", promptInput(b, "back"));
    assert.equal(failed.status, 0);
    assert.match(failed.json.systemMessage, /^brb UserPromptSubmit failed open: /);
    assert.ok(readAway("s1", b.env), "the hold is still on");
    assert.match(readFileSync(join(b.stateDir("s1"), "digest.md"), "utf8"), /Rotate the staging token/, "the digest is not archived");
    hold("s1", "Merge the docs branch", { env: b.env });
    rmSyncFile(list);
    const back = runHook(b, "user-prompt-submit", promptInput(b, "back")).json.systemMessage;
    assert.match(back, /\n1\. Approve the schema change\n2\. Rotate the staging token\n3\. Merge the docs branch\n/);
    assert.equal(readAway("s1", b.env), null);
    // The archive step failing after the rows were written: the retry adds only what is new.
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold("s1", "Pick a cache", { env: b.env });
    const archive = join(b.stateDir("s1"), "archive");
    rmSyncFile(archive);
    writeFileSync(archive, "not a directory");
    const half = runHook(b, "user-prompt-submit", promptInput(b, "back"));
    assert.match(half.json.systemMessage, /^brb UserPromptSubmit failed open: /);
    assert.equal(readChecklist("s1", b.env).items.length, 4, "the rows were written before the archive step");
    hold("s1", "Tag the release", { env: b.env });
    rmSyncFile(archive);
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    assert.deepEqual(readChecklist("s1", b.env).items.map((i) => i.text), ["Approve the schema change", "Rotate the staging token", "Merge the docs branch", "Pick a cache", "Tag the release"]);
    assert.ok(readChecklist("s1", b.env).archived.every((a) => existsSync(a)), "every archive path named exists");
  } finally {
    b.release();
  }
});

test("one item past the cap: the whole item goes to an export, the agent gets its start and the path, under the context limit; a failed export points at checklist.json with a systemMessage", () => {
  const b = box();
  try {
    runHook(b, "user-prompt-submit", promptInput(b, "brb"));
    hold("s1", HUGE("big"), { env: b.env });
    runHook(b, "user-prompt-submit", promptInput(b, "back"));
    const r = runHook(b, "user-prompt-submit", promptInput(b, "1"));
    assert.equal(r.status, 0);
    const agent = r.json.hookSpecificOutput.additionalContext;
    assert.ok(agent.length < CONTEXT_LIMIT, `context ${agent.length}`);
    assert.match(agent, /^brb: Jo opened item 1 of the returned digest\. It is too long to show whole here/);
    const m = /the whole text: (\/[^)]+\.md)\)$/.exec(agent);
    assert.ok(m && m[1].includes("/export/"), agent.slice(-200));
    assert.ok(readFileSync(m[1], "utf8").includes(HUGE("big")), "the item whole in the export");
    assert.ok(!agent.includes("END-big"), "the context itself is cut");
    assert.equal(r.json.systemMessage, undefined);
    assert.equal(readChecklist("s1", b.env).items[0].done, false, "showing ticks nothing");
    // A failed export: the context still fits and points at checklist.json; Jo sees why.
    rmSyncFile(join(b.stateDir("s1"), "export"));
    writeFileSync(join(b.stateDir("s1"), "export"), "not a directory");
    const f = runHook(b, "user-prompt-submit", promptInput(b, "brb item 1"));
    assert.equal(f.status, 0);
    assert.ok(f.json.hookSpecificOutput.additionalContext.length < CONTEXT_LIMIT);
    assert.ok(f.json.hookSpecificOutput.additionalContext.endsWith(`the whole text: ${checklistPath("s1", b.env)})`));
    assert.match(f.json.systemMessage, /^brb: item 1 is too long to show whole and its export could not be written \(.*\); the whole item is still in /);
  } finally {
    b.release();
  }
});

function rmSyncFile(p) {
  rmSync(p, { recursive: true, force: true });
}
