// needs-you-first.test.mjs — node --test
//
// The false-positive cases are the point of this file. Every check this plugin ships has to carry
// the shapes that must NOT flag, because a structural check earns its place by what it leaves
// alone: the cheapest way to satisfy a guard that fires on correct output is to stop writing the
// thing it misreads.
//
// Run: node --test plugins/communication-rules/checks/

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNeedsYouFirst } from "./needs-you-first.mjs";

const filler = (n) => "This sentence is ordinary body prose that carries findings. ".repeat(n);

// ─── must not flag ───────────────────────────────────────────────────────────

test("a correct message with nothing needing the reader is not applicable, not flagged", () => {
  const r = checkNeedsYouFirst(filler(8));
  assert.equal(r.flagged, false);
  assert.equal(r.applicable, false);
  assert.equal(r.reason, "no-marker");
});

test("a short message is below the floor even when it is misordered", () => {
  const r = checkNeedsYouFirst("Done.\n\nNeeds you\n\nPick a name.");
  assert.equal(r.applicable, false);
  assert.equal(r.reason, "below-floor");
  assert.equal(r.flagged, false);
});

test("marker first passes, and the marker's own forms are one marker", () => {
  for (const form of ["Needs you", "**Needs you**", "## Needs you", "Needs you:", "**Needs you:**"]) {
    const r = checkNeedsYouFirst(`${form}\n\nDecide the name.\n\n## Body\n\n${filler(8)}`);
    assert.equal(r.flagged, false, `${form} should not flag`);
    assert.equal(r.reason, "marker-first");
    assert.equal(r.applicable, true);
  }
});

test("a heading above the marker is navigation, not prose", () => {
  const r = checkNeedsYouFirst(`# Report on the thing\n\n## Needs you\n\nDecide.\n\n${filler(8)}`);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "marker-first");
});

test("a marker inside a fenced code block is an example, not a marker", () => {
  const r = checkNeedsYouFirst(`${filler(8)}\n\n\`\`\`\nNeeds you\n\`\`\`\n`);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "no-marker");
  assert.equal(r.markerLine, null);
});

test("an interleaved message is judged on its first marker, so not batching is not punished", () => {
  const body = `Needs you\n\nDecide the name.\n\n${filler(4)}\n\nNeeds you\n\nAnd approve the push.\n\n${filler(4)}`;
  const r = checkNeedsYouFirst(body);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "marker-first");
});

test("a trailing HTML-comment envelope is neither prose nor a marker", () => {
  const r = checkNeedsYouFirst(`Needs you\n\nDecide.\n\n${filler(8)}\n\n<!-- output-types\ntier: 0\nNeeds you: 1\n-->`);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "marker-first");
});

test("a quoted needs-you line from an earlier message is not this message's marker", () => {
  const r = checkNeedsYouFirst(`${filler(8)}\n\n> Needs you\n> Decide the name.\n`);
  assert.equal(r.reason, "no-marker");
  assert.equal(r.flagged, false);
});

test("graceChars tolerates a house-style preamble without loosening the rest", () => {
  const preamble = "Reporting back on the audit.\n\n";
  const text = `${preamble}Needs you\n\nDecide.\n\n${filler(8)}`;
  assert.equal(checkNeedsYouFirst(text).flagged, true);
  assert.equal(checkNeedsYouFirst(text, { graceChars: 40 }).flagged, false);
});

// ─── must flag ───────────────────────────────────────────────────────────────

test("body before the needs-you section is the one finding this check exists for", () => {
  const r = checkNeedsYouFirst(`${filler(8)}\n\nNeeds you\n\nDecide the name.`);
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "prose-precedes-marker");
  assert.ok(r.prosePrecedingChars > 200);
  assert.ok(r.markerLine > 1);
});

test("a needs-you section buried under a body heading still flags", () => {
  const r = checkNeedsYouFirst(`# Report\n\n## Findings\n\n${filler(8)}\n\n## Needs you\n\nDecide.`);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "prose-precedes-marker");
});

// ─── contract ────────────────────────────────────────────────────────────────

test("operator markers replace the default rather than extending it", () => {
  const text = `${filler(8)}\n\nAction required\n\nDecide.`;
  assert.equal(checkNeedsYouFirst(text).reason, "no-marker");
  assert.equal(checkNeedsYouFirst(text, { markers: ["Action required"] }).flagged, true);
});

test("it never throws and never reports flagged without applicable", () => {
  for (const input of [undefined, null, "", 0, "\n\n\n", "```\n", "<!--\n"]) {
    const r = checkNeedsYouFirst(input);
    assert.equal(typeof r.flagged, "boolean");
    assert.ok(!(r.flagged && !r.applicable), "flagged implies applicable");
  }
});
