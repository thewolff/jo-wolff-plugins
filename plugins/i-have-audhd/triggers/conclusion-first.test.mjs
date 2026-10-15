// conclusion-first.test.mjs — node --test
//
// The not-applicable cases are the point: the judge question is expensive and imprecise on
// short messages, and the trigger's whole job is to keep those away from it. The Stop hook
// runs it per unit (checks/sections.mjs), so "message" below is one unit.
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

test("fenced and comment lines carry no prose chars toward the floor", () => {
  const fence = `${filler(3)}\n\n\`\`\`\n${filler(6)}\n\`\`\``;
  assert.equal(conclusionFirstApplicable(fence).applicable, false);

  const envelope = `${filler(3)}\n\n<!-- envelope\n${filler(6)}\n-->`;
  assert.equal(conclusionFirstApplicable(envelope).applicable, false);
});

// ─── must fire ───────────────────────────────────────────────────────────────

test("one long paragraph over the floor fires: its point can sit past word 20", () => {
  const r = conclusionFirstApplicable(filler(12)); // ~780 chars, one paragraph
  assert.equal(r.applicable, true);
  assert.ok(r.proseChars >= 400);
});

test("two substantive paragraphs over the floor fire", () => {
  const r = conclusionFirstApplicable(`${filler(6)}\n\n${filler(6)}`);
  assert.equal(r.applicable, true);
  assert.ok(r.proseChars >= 400);
});

test("the floor is configurable", () => {
  const msg = "One.\n\nTwo.";
  assert.equal(conclusionFirstApplicable(msg).applicable, false);
  assert.equal(conclusionFirstApplicable(msg, { minProseChars: 3 }).applicable, true);
});
