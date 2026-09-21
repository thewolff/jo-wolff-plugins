// closing-ask-last.test.mjs — node --test
//
// The false-positive cases are the point of this file, same proportion as the
// needs-you-first suite: a structural check earns its place by what it leaves alone.
//
// Run: node --test plugins/communication-rules/checks/

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClosingAskLast } from "./closing-ask-last.mjs";

const filler = (n) => "This sentence is ordinary body prose that carries findings. ".repeat(n);

// ─── must not flag ───────────────────────────────────────────────────────────

test("a correct message with no closing-ask marker is not applicable, not flagged", () => {
  const r = checkClosingAskLast(`${filler(6)}`);
  assert.equal(r.applicable, false);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "no-marker");
  assert.equal(r.markerCount, 0);
});

test("a short message is below the floor even when prose trails the ask", () => {
  const r = checkClosingAskLast("Closing ask\n\nApprove it.\n\nTrailing line.");
  assert.equal(r.applicable, false);
  assert.equal(r.reason, "below-floor");
});

test("an ask followed only by an HTML-comment envelope is still last", () => {
  const msg = `${filler(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n<!-- envelope: kept for the record -->`;
  const r = checkClosingAskLast(msg);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "single-ask-last");
});

test("an ask followed only by a heading is still last — navigation is not prose", () => {
  const msg = `${filler(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n## Details`;
  const r = checkClosingAskLast(msg);
  assert.equal(r.reason, "single-ask-last");
  assert.equal(r.flagged, false);
});

test("the marker's own three spellings are one marker", () => {
  for (const spelling of ["## Closing ask", "**Closing ask**", "Closing ask:"]) {
    const r = checkClosingAskLast(`${filler(6)}\n\n${spelling}\n\nApprove the deploy.`);
    assert.equal(r.markerCount, 1, spelling);
    assert.equal(r.reason, "single-ask-last", spelling);
  }
});

test("a marker inside a fenced code block is an example, not a marker", () => {
  const msg = `${filler(6)}\n\n\`\`\`\n## Closing ask\n\`\`\`\n\nMore body prose here.`;
  const r = checkClosingAskLast(msg);
  assert.equal(r.markerCount, 0);
  assert.equal(r.applicable, false);
});

test("a quoted closing-ask line from an earlier message is not this message's marker", () => {
  const msg = `${filler(6)}\n\n> Closing ask\n> from the previous thread\n\nAnd my answer continues.`;
  const r = checkClosingAskLast(msg);
  assert.equal(r.markerCount, 0);
  assert.equal(r.reason, "no-marker");
});

test("content on the marker's own line is a sentence, not a section opener", () => {
  // "Closing ask: approve it" inline is NOT matched — the marker is line-anchored, so this
  // message has no marker section and the check declines to have an opinion.
  const r = checkClosingAskLast(`${filler(6)}\n\nThe closing ask: approve it today.`);
  assert.equal(r.markerCount, 0);
  assert.equal(r.reason, "no-marker");
});

test("graceChars tolerates a one-line sign-off after the ask", () => {
  const msg = `${filler(6)}\n\n## Closing ask\n\nApprove the deploy.\n\nThanks for the review.`;
  const r = checkClosingAskLast(msg, { graceChars: 40 });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "single-ask-last");
});

// ─── must flag ───────────────────────────────────────────────────────────────

test("two closing-ask markers is the multiple-markers finding", () => {
  const msg = `${filler(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n${filler(2)}\n\n**Closing ask**\n\nAlso answer the question.`;
  const r = checkClosingAskLast(msg);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "multiple-markers");
  assert.equal(r.markerCount, 2);
});

test("substantive prose after the single ask is the overtime finding", () => {
  const msg = `${filler(6)}\n\n## Closing ask\n\nApprove the deploy.\n\n${filler(2)}`;
  const r = checkClosingAskLast(msg);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "prose-after-ask");
  assert.ok(r.proseAfterChars > 0);
});

// ─── contract ────────────────────────────────────────────────────────────────

test("operator markers replace the default rather than extending it", () => {
  const msg = `${filler(6)}\n\n## Decision wanted\n\nApprove it.`;
  const withDefault = checkClosingAskLast(msg);
  assert.equal(withDefault.markerCount, 0);
  const withCustom = checkClosingAskLast(msg, { markers: ["Decision wanted"] });
  assert.equal(withCustom.markerCount, 1);
  assert.equal(withCustom.reason, "single-ask-last");
});

test("it never throws and never reports flagged without applicable", () => {
  for (const bad of [undefined, null, 7, "", "**", "```", "\n\n\n", { toString: () => "x" }]) {
    const r = checkClosingAskLast(bad);
    assert.equal(typeof r.flagged, "boolean");
    assert.equal(typeof r.applicable, "boolean");
    if (r.flagged) assert.equal(r.applicable, true);
  }
});
