// test/sections.test.mjs — lib/sections.mjs splitNeedsYou: heading variants, the on-fire matcher
// (bold, bullets, outside the section), the closing ask, the idle line, no section at all; and
// lib/text.mjs surfaceWord. node --test.

import test from "node:test";
import assert from "node:assert/strict";

import { ON_FIRE, fireText, normalizeLine, splitNeedsYou } from "../lib/sections.mjs";
import { surfaceWord } from "../lib/text.mjs";

const body = (heading) => `Did the work.\n\n${heading}\n- Pick Redis or in-process for the cache\n- Approve the schema change\n\n## Next\n- more work`;

test("heading variants open the section: ##, ###, bold, bold with colon, plain with colon, any case, counts, numbers, emoji", () => {
  const forms = ["## Needs you", "### Needs you", "**Needs you**", "**Needs you:**", "**Needs you**:", "Needs you:", "## NEEDS YOU", "# needs you"];
  forms.push("## Needs you (2)", "**Needs you** — 2 items", "1. **Needs you**", "### 🔴 Needs you", "🙋 **Needs you**", "## Needs you 2");
  for (const h of forms) {
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

test("idle line: among the last five non-blank lines; the reason is captured; bare idle: is empty", () => {
  assert.equal(splitNeedsYou("Nothing left.\n\nidle: every item waits on the cache choice\n\n").idle, "every item waits on the cache choice");
  assert.equal(splitNeedsYou("**idle:** waiting").idle, "waiting");
  assert.equal(splitNeedsYou("idle:").idle, "");
  assert.equal(splitNeedsYou("## Needs you\n- x\n\nidle: waiting on cache\n\nClosing ask: Redis or in-process?").idle, "waiting on cache", "a closing ask may follow");
  assert.equal(splitNeedsYou("idle: early\n1\n2\n3\n4\n5").idle, null, "six lines from the end is too early");
  assert.equal(splitNeedsYou("idle: early\n1\n2\n3\n4").idle, "early");
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
  assert.deepEqual(surfaceWord("Back."), { word: "back", note: "" });
  assert.deepEqual(surfaceWord("back!"), { word: "back", note: "" });
  assert.deepEqual(surfaceWord("pending?"), { word: "pending", note: "" });
  assert.deepEqual(surfaceWord("brb, lunch"), { word: "brb", note: "lunch" });
  assert.deepEqual(surfaceWord("brb: lunch"), { word: "brb", note: "lunch" });
  assert.deepEqual(surfaceWord("brb."), { word: "brb", note: "" });
  assert.equal(surfaceWord("back it out"), null);
  assert.equal(surfaceWord("brbx"), null);
  assert.equal(surfaceWord("backlog"), null);
});

test("on fire: none / nothing are statuses, not fires; emoji and quote prefixes are fires; the text drops the marker", () => {
  assert.deepEqual(splitNeedsYou("Status.\n\nOn fire: none.\n\n## Needs you\n- Pick a cache").onFire, []);
  assert.deepEqual(splitNeedsYou("- **On fire:** nothing right now").onFire, []);
  assert.deepEqual(splitNeedsYou("on fire: n/a").onFire, []);
  assert.deepEqual(splitNeedsYou("🔥 on fire: main red").onFire, ["🔥 on fire: main red"]);
  assert.deepEqual(splitNeedsYou("> on fire: main red").onFire, ["> on fire: main red"]);
  assert.deepEqual(splitNeedsYou("- 🔥 **on fire:** main red").onFire, ["- 🔥 **on fire:** main red"]);
  assert.deepEqual(splitNeedsYou("on fire: nothing builds on main").onFire, ["on fire: nothing builds on main"], "a fire that starts with 'nothing' is still a fire");
  assert.equal(fireText("- **on fire:** main is red"), "main is red");
  assert.equal(fireText("🔥 on fire: main red"), "main red");
  assert.equal(fireText("On fire: none."), null);
  assert.equal(fireText("not a fire"), null);
});

test("held items: an indented continuation joins its item; a nothing line is not held", () => {
  assert.deepEqual(splitNeedsYou("## Needs you\n- Pick a cache\n  because the deploy needs it\n- Approve the schema").held, ["- Pick a cache because the deploy needs it", "- Approve the schema"]);
  assert.deepEqual(splitNeedsYou("## Needs you\n- Pick a cache\n  - a nested option").held, ["- Pick a cache", "- a nested option"], "a nested list item stays its own item");
  assert.deepEqual(splitNeedsYou("## Needs you\nNothing right now.").held, []);
  assert.deepEqual(splitNeedsYou("## Needs you\n- None.").held, []);
  assert.deepEqual(splitNeedsYou("## Needs you\n- Nothing in the config is decided; pick one").held, ["- Nothing in the config is decided; pick one"]);
});
