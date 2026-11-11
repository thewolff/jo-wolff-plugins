// sections.test.mjs — node --test
//
// labelOf decides which lines are output-types receipt labels; checks/handed-command.mjs reads
// the block under one as a receipt, exempt from rule 10. So the cases that must NOT read as a
// label carry as much weight as the ones that must: an inline, quoted, fenced or commented label
// is not a receipt. Receipt blocks are never judge units (hooks/receipt-blocks.test.mjs); the
// opening window below is what the conclusion-first and bad-news-first judges are shown.
//
// Run: node --test 'plugins/i-have-audhd/checks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLines } from "./lines.mjs";
import { labelOf, openingWords, OPENING_WORDS } from "./sections.mjs";

const words = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join(" ");

// Every receipt label line in `text`, as { line, label }.
const labelsIn = (text) =>
  classifyLines(text)
    .map((entry) => ({ line: entry.number, label: labelOf(entry) }))
    .filter((l) => l.label);

// ─── labelOf ─────────────────────────────────────────────────────────────────

test("no label line: no labels, and null-ish input never throws", () => {
  assert.deepEqual(labelsIn("## Report\n\nThe deploy went out.\n"), []);
  assert.deepEqual(labelsIn(undefined), []);
});

test("each receipt label line is found with its line and its label as written", () => {
  const report = [
    "Status of the deploy, in three parts.", // 1
    "", // 2
    "**CLAIM**", // 3
    "The deploy went out at noon.", // 4
    "", // 5
    "**CITE(vendor docs)**", // 6
    "The TTL defaults to 60s.", // 7
    "", // 8
    "**CITE**:", // 9
    "The vendor docs say the TTL is 60s.", // 10
  ].join("\n");
  const expected = [
    { line: 3, label: "CLAIM" },
    { line: 6, label: "CITE(vendor docs)" },
    { line: 9, label: "CITE" },
  ];
  assert.deepEqual(labelsIn(report), expected);
  assert.deepEqual(labelsIn(report.replace(/\n/g, "\r\n")), expected, "CRLF reads the same as LF");
});

test("a parenthetical inside the bold and a trailing colon are label lines", () => {
  for (const label of ["CLAIM", "CITE"]) {
    for (const form of [`**${label}**`, `**${label}**:`, `**${label}(inference)**`, `**${label}:**`]) {
      assert.deepEqual(labelsIn(`Intro.\n${form}\nBody.`).map((l) => l.line), [2], form);
    }
  }
});

test("retired labels (PMDW, GUESS, ACTION, QUESTION) are plain prose", () => {
  for (const label of ["PMDW", "GUESS", "ACTION", "QUESTION", "GUESS(inference)"]) {
    assert.deepEqual(labelsIn(`Intro.\n**${label}**\nBody.`), [], label);
  }
});

test("an inline or bulleted bold label is not a label line", () => {
  for (const line of ["- **CLAIM** the cache is warm.", "**CLAIM** the cache is warm.", "The **CLAIM** is inline.", "**claim**", "**NOTE**"]) {
    assert.deepEqual(labelsIn(`Intro.\n${line}\nBody.`), [], line);
  }
});

test("a label inside a fence, a blockquote, or an HTML comment is not a label line", () => {
  for (const text of [
    "Intro.\n```\n**CLAIM**\n```\nBody.",
    "Intro.\n> **CLAIM**\nBody.",
    "Intro.\n<!-- envelope\n**CLAIM**\n-->\nBody.",
    "Intro.\n<!-- **CLAIM** -->\nBody.",
  ]) {
    assert.deepEqual(labelsIn(text), [], text);
  }
});

test("a comment opened mid-line hides a label below it; the text before `<!--` stays prose", () => {
  const text = "Intro <!-- hidden\n**CLAIM**\n-->";
  assert.deepEqual(labelsIn(text), []);
  assert.equal(openingWords(text), "Intro");
});

test("a fence delimiter inside a comment does not toggle fence state or hide a later label", () => {
  assert.deepEqual(labelsIn("<!-- sample\n```\n-->\n**CITE**\nThe vendor docs say so."), [{ line: 4, label: "CITE" }]);
});

test("a `<!--` inside an inline code span opens no comment, whatever the span's backtick count", () => {
  for (const text of [
    "Write `<!--` to start one.\n**CLAIM**\nBody.",
    "Write ``<!--`` to start one.\n**CLAIM**\nBody.",
    "Write ``a ` <!-- b`` to start one.\n**CLAIM**\nBody.",
  ]) {
    assert.deepEqual(labelsIn(text), [{ line: 2, label: "CLAIM" }], text);
  }
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
