// sections.mjs — the opening window the conclusion-first and bad-news-first judgments read, and
// the output-types receipt label line.
//
// RECEIPT BLOCKS ARE NOT JUDGE UNITS
//   A message written under the output-types contract carries receipt blocks for its receipted
//   facts: a bold **CLAIM** or **CITE** label alone on a line, then the evidence (a path and
//   line, a command and its output, a fetched source). From 1.1.0 to 1.7.1 the Stop hook split a
//   message at those label lines and judged each block "as its own message" for conclusion-first
//   and bad-news-first. A receipt opens with its evidence by design, and the judge read that
//   evidence as setup burying the point; a block also ran on to the next label, so it swallowed
//   the prose and closing ask after it. A blind re-measure on 2026-11-10 traced every
//   conclusion-first false alarm on two judge models to a receipt block judged alone. Since
//   1.7.2 a receipt block belongs to the point it backs, and the only labels that ever opened a
//   unit are receipt labels, so both judgments read the whole message, as they always did for a
//   message without labels. Headings (`## Needs you` and the rest) never opened a unit and still
//   do not.
//
// WHAT A LABEL LINE IS
//   A prose line (checks/lines.mjs classifyLines: fences, HTML comments and blockquotes are
//   never prose) whose trimmed text is exactly one bold receipt label — optionally with a
//   parenthetical inside the bold (**CITE(vendor docs)**) and a trailing colon (**CLAIM**:).
//   A label mid-sentence or in a bullet (`- **CLAIM** the cache…`) is inline: the output-types
//   contract's "block-leading label" rule. PMDW, GUESS, ACTION and QUESTION were retired by the
//   output-types contract (0.2.0), so a line reading `**GUESS**` is ordinary prose.
//   checks/handed-command.mjs uses labelOf to find receipts, which are exempt from rule 10.
//
// THE OPENING WINDOW
//   "At the start" is the message's first 20 words, computed here rather than left to a judge's
//   reading of "first sentence": bad news at the end of a 40-word first sentence is buried.
//   The words are those of the heading and prose lines in order, normalized the way
//   classifyLines normalizes them (hashes, bullets, emphasis stripped), so fenced, comment and
//   quoted lines never count. The window crosses line, sentence and paragraph boundaries.
//
// Usage:
//   import { labelOf, openingWords, OPENING_WORDS } from "./sections.mjs";

import { classifyLines } from "./lines.mjs";

export const RECEIPT_LABELS = ["CLAIM", "CITE"];

// The opening window's size, in words. A module constant, not a profile setting.
export const OPENING_WORDS = 20;

// `**LABEL**`, `**LABEL(note)**`, a trailing colon inside or after the bold.
const LABEL_LINE = new RegExp(
  `^\\*\\*((?:${RECEIPT_LABELS.join("|")})(?:\\s*\\([^()*]*\\))?)(?::\\*\\*|\\*\\*:?)$`,
);

// The receipt label a classified line carries, as written inside the bold ("CLAIM",
// "CITE(vendor docs)"), or null. Only prose lines qualify; see the header.
export function labelOf(entry) {
  if (entry.kind !== "prose") return null;
  const m = LABEL_LINE.exec(entry.raw.trim());
  return m ? m[1] : null;
}

// openingWords(text, n = OPENING_WORDS) → the first n words of the text's heading and prose
// lines, joined by single spaces; all of them when there are fewer. Never throws.
export function openingWords(text, n = OPENING_WORDS) {
  const words = [];
  for (const { kind, norm } of classifyLines(text)) {
    if (kind !== "heading" && kind !== "prose") continue;
    for (const word of norm.split(/\s+/)) {
      if (!word) continue;
      words.push(word);
      if (words.length >= n) return words.join(" ");
    }
  }
  return words.join(" ");
}
