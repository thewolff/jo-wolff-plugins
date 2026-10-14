// conclusion-first.test.mjs — node --test
//
// The not-applicable cases are the point: the judge question is expensive and imprecise on
// short or single-paragraph messages, and the trigger's whole job is to keep those away
// from it.
//
// Run: node --test 'plugins/i-have-audhd/triggers/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { conclusionFirstApplicable } from "./conclusion-first.mjs";

const filler = (n) => "This sentence is ordinary body prose that carries findings. ".repeat(n);

// ─── must not fire ───────────────────────────────────────────────────────────

test("a short multi-paragraph message is below the floor", () => {
  const r = conclusionFirstApplicable("Short opener.\n\nShort close.");
  assert.equal(r.applicable, false);
  assert.ok(r.proseChars < 400);
});

test("one long paragraph has nowhere to bury a conclusion", () => {
  const r = conclusionFirstApplicable(filler(12)); // ~780 chars, one paragraph
  assert.equal(r.applicable, false);
  assert.equal(r.paragraphs, 1);
  assert.ok(r.proseChars >= 400);
});

test("headings and fences break paragraphs; comments do not", () => {
  const withHeading = `${filler(6)}\n\n## Section\n\n${filler(6)}`;
  assert.equal(conclusionFirstApplicable(withHeading).paragraphs, 2);

  const withFence = `${filler(6)}\n\n\`\`\`\ncode\n\`\`\`\n\n${filler(6)}`;
  assert.equal(conclusionFirstApplicable(withFence).paragraphs, 2);

  const withEnvelope = `${filler(4)}\n\n<!-- envelope\nstays\n-->\n\n${filler(4)}`;
  assert.equal(conclusionFirstApplicable(withEnvelope).paragraphs, 2);
  assert.equal(conclusionFirstApplicable(withEnvelope).applicable, true);
});

// ─── must fire ───────────────────────────────────────────────────────────────

test("two substantive paragraphs over the floor fire", () => {
  const r = conclusionFirstApplicable(`${filler(6)}\n\n${filler(6)}`);
  assert.equal(r.applicable, true);
  assert.equal(r.paragraphs, 2);
  assert.ok(r.proseChars >= 400);
});

test("the floors are configurable", () => {
  const msg = "One.\n\nTwo.";
  assert.equal(conclusionFirstApplicable(msg).applicable, false);
  assert.equal(conclusionFirstApplicable(msg, { minProseChars: 3, minParagraphs: 2 }).applicable, true);
  assert.equal(conclusionFirstApplicable(filler(12), { minParagraphs: 1 }).applicable, true);
});
