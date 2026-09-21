// bad-news-lexicon.test.mjs — node --test
//
// The gate is deliberately over-inclusive ("fixed the error" trips it), so the tests here
// prove the GATE's boundaries — floor, word-start matching, configurability — and leave the
// genuinely-bad-news question to the judge's tests.
//
// Run: node --test plugins/communication-rules/triggers/

import { test } from "node:test";
import assert from "node:assert/strict";
import { badNewsGate, badNewsQuestion } from "./bad-news-lexicon.mjs";

const filler = (n) => "This sentence is ordinary body prose that carries findings. ".repeat(n);

// ─── must not fire ───────────────────────────────────────────────────────────

test("a substantive message with no lexicon word does not fire", () => {
  const r = badNewsGate(filler(6));
  assert.equal(r.applicable, false);
  assert.deepEqual(r.hits, []);
});

test("a short message with a lexicon word is below the floor", () => {
  const r = badNewsGate("It failed.");
  assert.equal(r.applicable, false);
});

test("lexicon words match at word start: terror is not error", () => {
  const r = badNewsGate(`${filler(5)} The transaction was terror-adjacent but fine.`);
  assert.equal(r.applicable, false);
});

test("lexicon words inside a code fence are examples, not news", () => {
  const msg = `${filler(5)}\n\n\`\`\`\ngrep -i "failed" log.txt\n\`\`\``;
  const r = badNewsGate(msg);
  assert.equal(r.applicable, false);
});

// ─── must fire ───────────────────────────────────────────────────────────────

test("a substantive message with a lexicon word fires, and reports the hit", () => {
  const r = badNewsGate(`${filler(5)} The deploy failed on the migration step.`);
  assert.equal(r.applicable, true);
  assert.ok(r.hits.includes("failed"));
  assert.ok(r.proseChars >= 200);
});

test("plural and inflected forms match by prefix: errors, failures, broke", () => {
  const r = badNewsGate(`${filler(5)} Two errors and one failure remain.`);
  assert.ok(r.hits.includes("error"));
  assert.ok(r.hits.includes("failure"));
});

test("the lexicon is configurable and replaces the default", () => {
  const msg = `${filler(5)} The courtyard has been defenestrated.`;
  assert.equal(badNewsGate(msg).applicable, false);
  assert.equal(badNewsGate(msg, { lexicon: ["defenestrated"] }).applicable, true);
});

test("can't matches with its apostrophe", () => {
  const r = badNewsGate(`${filler(5)} We can't ship this as it stands.`);
  assert.ok(r.hits.includes("can't"));
});

// ─── contract ────────────────────────────────────────────────────────────────

test("the question carries the not-bad-news counterweight", () => {
  assert.match(badNewsQuestion, /NOT bad news/);
  assert.match(badNewsQuestion, /present, unresolved cost/);
  assert.match(badNewsQuestion, /violation=false/);
});

test("it never throws", () => {
  for (const bad of [undefined, null, 7, "", "```", { toString: () => filler(5) + " failed" }]) {
    const r = badNewsGate(bad);
    assert.equal(typeof r.applicable, "boolean");
  }
});
