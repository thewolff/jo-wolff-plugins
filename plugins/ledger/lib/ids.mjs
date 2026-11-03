// ids.mjs — row ids: `<prefix>-<base36 ms timestamp><4 random base36>`, e.g. `wl-mvr3k2p9a1xq`.
//
// The shape sorts by creation time and is short enough to type. The prefix names the table.

import { randomInt } from "node:crypto";

export const PREFIXES = Object.freeze({
  workload: "wl",
  question: "q",
  answer: "an",
  decision: "de",
  ceiling: "ce",
  session: "se",
});

const ALL = Object.values(PREFIXES);

/** Matches a complete id of any table. */
export const ID_RE = new RegExp(`^(${ALL.join("|")})-[a-z0-9]+$`);
/** Matches a prefix with the dash and nothing after it: `q-`, `wl-`. */
export const CUT_SHORT_RE = new RegExp(`^(${ALL.join("|")})-$`);

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newId(prefix, now = Date.now()) {
  let tail = "";
  for (let i = 0; i < 4; i++) tail += ALPHABET[randomInt(36)];
  return `${prefix}-${now.toString(36)}${tail}`;
}

/** The table prefix of an id (`wl`, `q`, …) or null when the text is not an id. */
export function prefixOf(text) {
  const m = ID_RE.exec(text);
  return m ? m[1] : null;
}

export function isId(text) {
  return ID_RE.test(text);
}

export function isCutShort(text) {
  return CUT_SHORT_RE.test(text);
}
