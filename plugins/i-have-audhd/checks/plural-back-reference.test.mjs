// plural-back-reference.test.mjs — node --test
//
// Same proportion as the other check suites: what the check leaves alone matters as much as
// what it flags.
//
// Run: node --test 'plugins/i-have-audhd/checks/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPluralBackReference } from "./plural-back-reference.mjs";

const CLI = fileURLToPath(new URL("./plural-back-reference.mjs", import.meta.url));
const body = "This sentence is ordinary body prose that carries findings. ".repeat(4);

// ─── must flag ───────────────────────────────────────────────────────────────

test("a bare back-reference in the ask is flagged", () => {
  const r = checkPluralBackReference("## Closing ask\nShould I merge those?");
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, true);
  assert.equal(r.reason, "referent-outside-sentence");
  assert.deepEqual(r.hits.map((h) => h.word), ["those"]);
  assert.equal(r.hits[0].line, 2);
});

test("'both of the files named above' points outside the sentence and is flagged", () => {
  const r = checkPluralBackReference(`${body}\n\n## Closing ask\n\nShould I merge both of the files named above?`);
  assert.equal(r.flagged, true);
  assert.deepEqual(r.hits.map((h) => h.word), ["both"]);
});

test("every lexicon entry is a hit when nothing in its sentence names the referent", () => {
  for (const phrase of ["Should I merge these?", "Should I merge both?", "Should I merge them?",
    "Should I merge the two?", "Should I take either one?"]) {
    const r = checkPluralBackReference(`**Closing ask**\n\n${phrase}`);
    assert.equal(r.flagged, true, phrase);
  }
});

test("a comma clause is not a list: 'them, or leave them' stays flagged", () => {
  const r = checkPluralBackReference("## Closing ask\nShould I merge them, or leave them for later?");
  assert.equal(r.flagged, true);
  assert.equal(r.hits.length, 2);
});

// ─── must not flag ───────────────────────────────────────────────────────────

test("explicit nouns in the same sentence acquit: both `foo.ts` and `bar.ts`", () => {
  const r = checkPluralBackReference("## Closing ask\nShould I merge both `foo.ts` and `bar.ts`?");
  assert.equal(r.applicable, true);
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "referent-in-sentence");
});

test("an apposition list acquits", () => {
  for (const phrase of [
    "Should I merge the two branches: the auth fix and the cache fix?",
    "Should I merge these (`a.ts`, `b.ts`)?",
    "Should I merge the two, `a.ts` and `b.ts`?",
  ]) {
    const r = checkPluralBackReference(`## Closing ask\n${phrase}`);
    assert.equal(r.flagged, false, phrase);
  }
});

test("named items before the pronoun acquit it", () => {
  const r = checkPluralBackReference("## Closing ask\nShould I take `foo.ts` and `bar.ts` and merge them?");
  assert.equal(r.flagged, false);
});

test("a sentence wrapped across lines keeps its referents", () => {
  const r = checkPluralBackReference("## Closing ask\nShould I merge both `foo.ts`\nand `bar.ts` into main?");
  assert.equal(r.flagged, false);
});

test("lexicon words inside inline code or quotes are not hits", () => {
  const r = checkPluralBackReference('## Closing ask\nShould I run `git rm these` and add "those" to the lexicon?');
  assert.equal(r.flagged, false);
  assert.equal(r.reason, "no-plural-reference");
});

test("no marker means not applicable; prose after the ask paragraph is not the ask", () => {
  assert.equal(checkPluralBackReference(`${body}\nShould I merge those?`).applicable, false);
  const r = checkPluralBackReference("## Closing ask\nShould I merge the auth fix?\n\nThose are all done.");
  assert.equal(r.flagged, false);
});

test("whole words only: 'bother' and 'thesis' are not hits", () => {
  const r = checkPluralBackReference("## Closing ask\nShould I bother finishing the thesis draft?");
  assert.equal(r.flagged, false);
});

// ─── contract ────────────────────────────────────────────────────────────────

test("the CLI reads stdin and prints the flagged result, exit 0", () => {
  const r = spawnSync(process.execPath, [CLI], { input: "## Closing ask\nShould I merge those?\n", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).flagged, true);
});
