// batch-heading.test.mjs — node --test
//
// The not-applicable cases are the point: the trigger fires ONLY on a trailing, non-empty,
// labeled section. Mid-message grouping, empty labels, fenced examples, and quoted text must
// all leave it quiet — the judge question is expensive and its applicability is this
// trigger's whole job.
//
// Run: node --test 'plugins/i-have-audhd/triggers/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { findTrailingBatchSection } from "./batch-heading.mjs";

const filler = (n) => "This sentence is ordinary body prose that carries findings. ".repeat(n);

// ─── must not fire ───────────────────────────────────────────────────────────

test("no labeled section anywhere means no trigger", () => {
  const r = findTrailingBatchSection(`${filler(6)}\n\n## Follow-ups\n\n${filler(2)}`);
  assert.equal(r.applicable, false);
});

test("a labeled section with a later # heading is mid-message, not trailing", () => {
  const msg = `${filler(4)}\n\n## Questions\n\nIs the cache warm?\n\n## Answer\n\n${filler(2)}`;
  const r = findTrailingBatchSection(msg);
  assert.equal(r.applicable, false);
});

test("an empty labeled section is ceremony, not a dump", () => {
  const r = findTrailingBatchSection(`${filler(6)}\n\n## Notes\n\n<!-- nothing yet -->`);
  assert.equal(r.applicable, false);
});

test("a labeled heading inside a fence is an example, not a section", () => {
  const msg = `${filler(6)}\n\n\`\`\`markdown\n## Uncertainties\n- one\n- two\n\`\`\`\n\n${filler(1)}`;
  const r = findTrailingBatchSection(msg);
  assert.equal(r.applicable, false);
});

test("a quoted labeled line from an earlier message is not a heading here", () => {
  const r = findTrailingBatchSection(`${filler(6)}\n\n> ## Questions\n> from before\n\n${filler(1)}`);
  assert.equal(r.applicable, false);
});

// ─── must fire ───────────────────────────────────────────────────────────────

test("a trailing Questions section with substance fires, with heading and line", () => {
  const msg = `${filler(5)}\n\n## Questions\n\nIs the cache warm?\nWhat about the timeout?`;
  const r = findTrailingBatchSection(msg);
  assert.equal(r.applicable, true);
  assert.equal(r.heading, "Questions");
  assert.equal(r.headingLine, 3);
});

test("a bold pseudo-heading counts: **Caveats** at the end fires", () => {
  const msg = `${filler(5)}\n\n**Caveats**\n\nThe timeout is unmeasured on this corpus.`;
  const r = findTrailingBatchSection(msg);
  assert.equal(r.applicable, true);
  assert.equal(r.heading, "Caveats");
});

test("the trigger takes the LAST candidate when several labels appear", () => {
  const msg = `${filler(4)}\n\n## Questions\n\nFirst question?\n\n## Notes\n\nFinal note here.`;
  const r = findTrailingBatchSection(msg);
  assert.equal(r.heading, "Notes");
});

test("configured headings replace the default set", () => {
  const msg = `${filler(5)}\n\n## Loose ends\n\nOne thing dangles.`;
  assert.equal(findTrailingBatchSection(msg).applicable, false);
  const r = findTrailingBatchSection(msg, { headings: ["Loose ends"] });
  assert.equal(r.applicable, true);
  assert.equal(r.heading, "Loose ends");
});

test("section prose chars count prose only, not comments or blanks", () => {
  const msg = `${filler(5)}\n\n## Notes\n\nReal note prose here.\n\n<!-- invisible -->`;
  const r = findTrailingBatchSection(msg);
  assert.equal(r.sectionProseChars, "Real note prose here.".length);
});
