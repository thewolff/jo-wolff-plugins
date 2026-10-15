// sections.test.mjs — node --test
//
// The split decides which text the conclusion-first and bad-news-first judges read, so the
// cases that must NOT open a section carry as much weight as the ones that must: an inline or
// quoted label that split a message would hand the judge half a section, and a label line left
// in the unit would make "PMDW" the section's opening word.
//
// Run: node --test 'plugins/i-have-audhd/checks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLabeledSections, openingWords, OPENING_WORDS } from "./sections.mjs";

const words = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join(" ");

// ─── splitLabeledSections: no labels ─────────────────────────────────────────

test("no label line: one unit, the whole text unchanged", () => {
  const text = "## Report\n\nThe deploy went out.\n\n- **GUESS** the cache is warm.\n";
  assert.deepEqual(splitLabeledSections(text), [{ label: null, line: 1, text }]);
});

test("null-ish input is one empty unit, never a throw", () => {
  assert.deepEqual(splitLabeledSections(undefined), [{ label: null, line: 1, text: "" }]);
});

// ─── splitLabeledSections: labeled ───────────────────────────────────────────

const report = [
  "Status of the deploy, in three parts.", // 1
  "", // 2
  "**CLAIM**", // 3
  "The deploy went out at noon.", // 4
  "", // 5
  "**GUESS(inference)**", // 6
  "The cache is probably warm.", // 7
  "Second line of the guess.", // 8
  "", // 9
  "**ACTION**:", // 10
  "Ran the smoke test.", // 11
].join("\n");

test("a preamble and three labeled sections split at the label lines, with their labels", () => {
  assert.deepEqual(splitLabeledSections(report), [
    { label: null, line: 1, text: "Status of the deploy, in three parts." },
    { label: "CLAIM", line: 3, text: "The deploy went out at noon." },
    { label: "GUESS(inference)", line: 6, text: "The cache is probably warm.\nSecond line of the guess." },
    { label: "ACTION", line: 10, text: "Ran the smoke test." },
  ]);
});

test("a basis inside the bold and a trailing colon open sections; every label opens one", () => {
  for (const label of ["PMDW", "CLAIM", "CITE", "GUESS", "ACTION", "QUESTION"]) {
    for (const form of [`**${label}**`, `**${label}**:`, `**${label}(inference)**`, `**${label}:**`]) {
      const units = splitLabeledSections(`Intro.\n${form}\nBody.`);
      assert.equal(units.length, 2, form);
      assert.equal(units[1].text, "Body.", form);
      assert.equal(units[1].line, 2, form);
    }
  }
});

test("the label line is not in the unit text", () => {
  for (const unit of splitLabeledSections(report)) {
    assert.doesNotMatch(unit.text, /\*\*(CLAIM|GUESS|ACTION)/);
  }
});

test("an inline or bulleted bold label does not open a section", () => {
  for (const line of ["- **GUESS** the cache is warm.", "**GUESS** the cache is warm.", "The **CLAIM** is inline.", "**claim**", "**NOTE**"]) {
    const text = `Intro.\n${line}\nBody.`;
    assert.deepEqual(splitLabeledSections(text), [{ label: null, line: 1, text }], line);
  }
});

test("a label inside a fence, a blockquote, or an HTML comment does not open a section", () => {
  for (const text of [
    "Intro.\n```\n**CLAIM**\n```\nBody.",
    "Intro.\n> **CLAIM**\nBody.",
    "Intro.\n<!-- envelope\n**CLAIM**\n-->\nBody.",
    "Intro.\n<!-- **CLAIM** -->\nBody.",
  ]) {
    assert.deepEqual(splitLabeledSections(text), [{ label: null, line: 1, text }], text);
  }
});

test("a comment opened mid-line hides a label below it; the text before `<!--` stays prose", () => {
  const text = "Intro <!-- hidden\n**CLAIM**\n-->";
  assert.deepEqual(splitLabeledSections(text), [{ label: null, line: 1, text }]);
  assert.equal(openingWords(text), "Intro");
});

test("a fence delimiter inside a comment does not toggle fence state or hide a later label", () => {
  const text = "<!-- sample\n```\n-->\n**ACTION**\nRan the smoke test.";
  const units = splitLabeledSections(text);
  assert.deepEqual(units[units.length - 1], { label: "ACTION", line: 4, text: "Ran the smoke test." });
});

test("a `<!--` inside an inline code span opens no comment, whatever the span's backtick count", () => {
  for (const text of [
    "Write `<!--` to start one.\n**CLAIM**\nBody.",
    "Write ``<!--`` to start one.\n**CLAIM**\nBody.",
    "Write ``a ` <!-- b`` to start one.\n**CLAIM**\nBody.",
  ]) {
    const units = splitLabeledSections(text);
    assert.equal(units.length, 2, text);
    assert.equal(units[1].label, "CLAIM", text);
  }
});

test("a heading directly above a label lands in the section that label opens", () => {
  const text = "**CLAIM**\nThe deploy went out.\n\n## Errors\n\n**ACTION**\nThe migration failed.";
  const units = splitLabeledSections(text);
  assert.deepEqual(units, [
    { label: "CLAIM", line: 1, text: "The deploy went out." },
    { label: "ACTION", line: 6, text: "## Errors\n\nThe migration failed." },
  ]);
});

test("a heading with prose under it stays in the unit it falls in", () => {
  const text = "**CLAIM**\nThe deploy went out.\n\n## Errors\n\nNone today.\n\n**ACTION**\nRan it.";
  const [claim, action] = splitLabeledSections(text);
  assert.equal(claim.text, "The deploy went out.\n\n## Errors\n\nNone today.");
  assert.equal(action.text, "Ran it.");
});

test("a heading-only preamble moves into the first section and no empty preamble is left", () => {
  const units = splitLabeledSections("## Report\n\n**CLAIM**\nThe deploy went out.");
  assert.deepEqual(units, [{ label: "CLAIM", line: 3, text: "## Report\n\nThe deploy went out." }]);
});

test("CRLF input splits the same as LF", () => {
  assert.deepEqual(splitLabeledSections(report.replace(/\n/g, "\r\n")), splitLabeledSections(report));
});

// ─── openingWords ────────────────────────────────────────────────────────────

test("the window is 20 words", () => {
  assert.equal(OPENING_WORDS, 20);
});

test("a 40-word first sentence is cut at word 20", () => {
  const sentence = `${words("w", 40)}.`;
  assert.equal(openingWords(sentence), words("w", 20));
});

test("the window crosses a line break and a paragraph break", () => {
  const text = `${words("a", 8)}\n${words("b", 5)}\n\n${words("c", 30)}`;
  assert.equal(openingWords(text), `${words("a", 8)} ${words("b", 5)} ${words("c", 7)}`);
});

test("markup is stripped: emphasis, heading hashes, bullets, backticks", () => {
  const text = "## The **result**\n- `npm test` passed _today_\n* second bullet";
  assert.equal(openingWords(text), "The result npm test passed today second bullet");
});

test("fenced, comment and blockquote lines are skipped", () => {
  const text = "One two.\n```\nfenced words here\n```\n<!-- a\ncomment words\n-->\n> quoted words\nThree four.";
  assert.equal(openingWords(text), "One two. Three four.");
});

test("under 20 words → all of them", () => {
  assert.equal(openingWords("Only five words are here."), "Only five words are here.");
  assert.equal(openingWords(""), "");
});
