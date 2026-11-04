// test/sections.test.mjs — lib/sections.mjs splitNeedsYou: heading variants, the on-fire matcher
// (bold, bullets, outside the section), the closing ask, the idle line, no section at all; and
// lib/text.mjs surfaceWord. node --test.

import test from "node:test";
import assert from "node:assert/strict";

import { ON_FIRE, normalizeLine, splitNeedsYou } from "../lib/sections.mjs";
import { surfaceWord } from "../lib/text.mjs";

const body = (heading) => `Did the work.\n\n${heading}\n- Pick Redis or in-process for the cache\n- Approve the schema change\n\n## Next\n- more work`;

test("heading variants open the section: ##, ###, bold, bold with colon, plain with colon, any case", () => {
  for (const h of ["## Needs you", "### Needs you", "**Needs you**", "**Needs you:**", "**Needs you**:", "Needs you:", "## NEEDS YOU", "# needs you"]) {
    const r = splitNeedsYou(body(h));
    assert.deepEqual(r.held, ["- Pick Redis or in-process for the cache", "- Approve the schema change"], h);
    assert.equal(r.section, "- Pick Redis or in-process for the cache\n- Approve the schema change", h);
  }
});

test("the section ends at the next heading, bold label line or rule", () => {
  const r1 = splitNeedsYou("## Needs you\n- a\n\n**CLAIM**\nreceipt text\n- not an ask");
  assert.deepEqual(r1.held, ["- a"]);
  const r2 = splitNeedsYou("## Needs you\n- a\n---\n- not an ask");
  assert.deepEqual(r2.held, ["- a"]);
  const r3 = splitNeedsYou("## Needs you\n- a\n- b\n## FYI\n- c");
  assert.deepEqual(r3.held, ["- a", "- b"]);
});

test("no section: held is empty, section is null; a sentence that merely mentions needs you opens nothing", () => {
  const r = splitNeedsYou("All done. Nothing needs you right now.\n- a bullet");
  assert.equal(r.section, null);
  assert.deepEqual(r.held, []);
  assert.deepEqual(r.onFire, []);
  assert.equal(r.closingAsk, null);
  assert.equal(r.idle, null);
  assert.deepEqual(splitNeedsYou(""), { section: null, held: [], onFire: [], closingAsk: null, idle: null });
  assert.deepEqual(splitNeedsYou(undefined).held, []);
});

test("on-fire matcher: plain, bold, bulleted, numbered, any case, hyphenated; not mid-line", () => {
  for (const l of ["on fire: main is red", "On Fire: data loss", "**on fire:** spend at 95%", "- on fire: x", "* **on fire**: y", "2. on fire: z", "on-fire: w", "  on fire x"]) assert.ok(ON_FIRE.test(l), l);
  for (const l of ["the build is on fire", "onfire: no", "- not on fire: x", "fire: x"]) assert.ok(!ON_FIRE.test(l), l);
});

test("on-fire lines leave held and are collected from the whole message, once each", () => {
  const r = splitNeedsYou("on fire: main is red after my push\n\n## Needs you\n- Pick a cache\n- **on fire:** spend is at 95% of the ceiling\n- on fire: main is red after my push\n\nClosing ask: which cache?");
  assert.deepEqual(r.held, ["- Pick a cache"]);
  assert.deepEqual(r.onFire, ["on fire: main is red after my push", "- **on fire:** spend is at 95% of the ceiling"]);
  assert.equal(r.closingAsk, "which cache?");
});

test("closing ask: inline line, bold inline, or its own section; the section form joins lines", () => {
  assert.equal(splitNeedsYou("## Needs you\n- a\n\nClosing ask: pick one").closingAsk, "pick one");
  assert.equal(splitNeedsYou("## Needs you\n- a\n\n**Closing ask:** pick one").closingAsk, "pick one");
  assert.equal(splitNeedsYou("## Needs you\n- a\n\n## Closing ask\nPick one,\nplease.").closingAsk, "Pick one, please.");
  const r = splitNeedsYou("## Needs you\n- a\n\n## Closing ask\nPick one.");
  assert.deepEqual(r.held, ["- a"], "the closing-ask section is not held");
});

test("idle line: only as the last non-blank line; the reason is captured; bare idle: is empty", () => {
  assert.equal(splitNeedsYou("Nothing left.\n\nidle: every item waits on the cache choice\n\n").idle, "every item waits on the cache choice");
  assert.equal(splitNeedsYou("**idle:** waiting").idle, "waiting");
  assert.equal(splitNeedsYou("idle:").idle, "");
  assert.equal(splitNeedsYou("idle: early\nthen more work").idle, null);
  const r = splitNeedsYou("## Needs you\n- a\nidle: nothing runnable");
  assert.equal(r.idle, "nothing runnable");
  assert.deepEqual(r.held, ["- a"], "the idle line is not an ask");
});

test("fenced code inside the section is kept in the section text but a fenced on fire is not a fire", () => {
  const r = splitNeedsYou("## Needs you\n- a\n```\non fire: in a fence\n```\n- b");
  assert.deepEqual(r.onFire, []);
  assert.ok(r.section.includes("on fire: in a fence"));
  assert.deepEqual(r.held, ["- a", "on fire: in a fence", "- b"]);
});

test("normalizeLine drops list markers, emphasis, case and whitespace", () => {
  assert.equal(normalizeLine("- **Pick   Redis**  "), "pick redis");
  assert.equal(normalizeLine("3) pick redis"), "pick redis");
  assert.equal(normalizeLine("Pick Redis"), normalizeLine("* pick redis"));
});

test("surfaceWord: brb with or without a note, back, pending, case-insensitive; sentences are not words", () => {
  assert.deepEqual(surfaceWord("brb"), { word: "brb", note: "" });
  assert.deepEqual(surfaceWord("  BRB  lunch,  back at 2 "), { word: "brb", note: "lunch, back at 2" });
  assert.deepEqual(surfaceWord("back"), { word: "back", note: "" });
  assert.deepEqual(surfaceWord("Pending\n"), { word: "pending", note: "" });
  assert.equal(surfaceWord("back now please"), null);
  assert.equal(surfaceWord("pending questions?"), null);
  assert.equal(surfaceWord("I'll brb"), null);
  assert.equal(surfaceWord(""), null);
  assert.equal(surfaceWord(undefined), null);
});
