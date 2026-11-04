// sections.mjs — what the Stop hook reads out of the agent's final message while Jo is away.
//
// The away instruction (lib/text.mjs) asks the agent for three things, and this file finds them:
//   1. a `Needs you` section: a line that is the heading (`## Needs you`, `**Needs you**`,
//      `Needs you:`; any heading depth, bold or not, a trailing colon or not, any case; a leading
//      list number or emoji, and a trailing count, parenthetical or ` — …` allowed: `## Needs you
//      (2)`, `**Needs you** — 2 items`, `1. **Needs you**`, `### 🔴 Needs you`) and the lines
//      under it up to the next heading, bold label line or horizontal rule. An indented line that
//      is not a list item joins the item above it; a line that only says there is nothing
//      (`None.`, `Nothing right now.`) is not an item;
//   2. `on fire:` lines: a line that starts with `on fire` (after an optional `>` quote, bullet
//      or number, emoji and `**`), any case, anywhere in the message — the costly failure is a
//      fire that waited, so the whole message is read, not only the section. `on fire: none`
//      (or `nothing`, `n/a`) is a status, not a fire;
//   3. an `idle: <why>` line among the last five non-blank lines (a closing ask may follow it).
// The closing ask, when the message has one, travels into the digest too: a `Closing ask`
// section (same heading rule), or a line that starts with `Closing ask:`.
//
// Same idea as i-have-audhd's checks/sections.mjs (a message split at label lines), written
// for these three markers; nothing is imported from that plugin. Pure; never throws on a string.

const EMOJI = String.raw`(?:[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\u{FE0F}\u{200D}\p{Extended_Pictographic}]*\s*)`;

/** The on-fire marker at the start of a line: optional `>` quotes, list marker, emoji and `**` around `on fire`. */
export const ON_FIRE = new RegExp(String.raw`^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?${EMOJI}*(?:\*\*|__)?\s*${EMOJI}*on[ -]fire\b`, "iu");

/** A line that says there is nothing: `none`, `nothing`, `n/a`, `no`, with `right now`-style tails. */
const EMPTY = /^(?:none|nothing|n\/a|no)(?:\s+(?:right now|for now|yet|at the moment|so far|today|currently|here|on fire))*\s*[.!]?$/i;

/** The text after an on-fire marker (`main is red` for `- **on fire:** main is red`), or null when the line is not a fire or says nothing is. */
export function fireText(line) {
  const m = ON_FIRE.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length).replace(/^\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*:?\s*/, "").trim();
  return EMPTY.test(rest.replace(/\*\*|__/g, "").trim()) ? null : rest;
}

const IDLE = /^\s*(?:\*\*|__)?\s*idle\s*:\s*(?:\*\*|__)?\s*(.*?)\s*(?:\*\*|__)?\s*$/i;
const IDLE_WINDOW = 5;
const HEADING = /^\s*#{1,6}\s+\S/;
const BOLD_LABEL = /^\s*(?:\*\*|__)[^*_].*?(?:\*\*|__):?\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LEADING_EMOJI = new RegExp(`^${EMOJI}+`, "u");

/** A line's words as a heading would carry them: `#`s, a list number, emoji and emphasis dropped, lower case. */
function headingText(line) {
  const s = line.trim().replace(/^#{1,6}\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/\*\*|__/g, "").trim().replace(LEADING_EMOJI, "");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

const isNeedsYou = (line) => /^needs you\s*:?(?:\s*(?:\([^)]*\)|[—–]\s*.*|-\s+.*|\d+\b.*))?\s*:?$/.test(headingText(line));
const isClosingAsk = (line) => /^closing ask\s*:?$/.test(headingText(line));
const opensSection = (line) => HEADING.test(line) || BOLD_LABEL.test(line) || RULE.test(line);

/** A line for comparison: list marker, emphasis and extra whitespace dropped, lower case. */
export function normalizeLine(line) {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * splitNeedsYou(text) → { section, held, onFire, closingAsk, idle }
 *   section     the Needs-you section's text (heading dropped), or null when there is none
 *   held        the section's items that are not on fire, trimmed, in order: an indented non-list line
 *               joins the item above it; a line that only says there is nothing is dropped
 *   onFire      every on-fire line in the message, trimmed, in order, no repeats (`on fire: none` is not one)
 *   closingAsk  the closing ask's text, or null
 *   idle        the reason on the last `idle:` line among the last five non-blank lines ("" for a bare
 *               `idle:`), or null when there is none
 */
export function splitNeedsYou(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = { section: null, held: [], onFire: [], closingAsk: null, idle: null };
  let inFence = false;
  let mode = null; // "needs" | "closing" | null
  const sectionLines = [];
  const closingLines = [];
  const fire = new Set();
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      if (mode === "needs") sectionLines.push(line);
      continue;
    }
    if (inFence) {
      if (mode === "needs") sectionLines.push(line);
      continue;
    }
    if (isNeedsYou(line)) {
      mode = "needs";
      out.section = "";
      continue;
    }
    if (isClosingAsk(line)) {
      mode = "closing";
      continue;
    }
    const inlineAsk = /^\s*(?:\*\*|__)?\s*closing ask\s*:?\s*(?:\*\*|__)?\s*:?\s*(.+?)\s*$/i.exec(line);
    if (inlineAsk && !opensSection(line)) {
      out.closingAsk = inlineAsk[1];
      mode = null;
      continue;
    }
    if (mode && opensSection(line)) mode = null;
    if (ON_FIRE.test(line)) {
      const what = fireText(line);
      const key = what === null ? "" : what.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      if (key && !fire.has(key)) {
        fire.add(key);
        out.onFire.push(line.trim());
      }
      continue;
    }
    if (mode === "needs") sectionLines.push(line);
    else if (mode === "closing") closingLines.push(line);
  }
  if (out.section !== null) {
    out.section = sectionLines.join("\n").replace(/^\n+|\n+$/g, "");
    for (const l of sectionLines) {
      const t = l.trim();
      if (!t || IDLE.test(t) || FENCE.test(t) || EMPTY.test(normalizeLine(t))) continue;
      if (/^\s+\S/.test(l) && !LIST_ITEM.test(l) && out.held.length) out.held[out.held.length - 1] += ` ${t}`;
      else out.held.push(t);
    }
  }
  if (out.closingAsk === null && closingLines.some((l) => l.trim())) {
    out.closingAsk = closingLines.map((l) => l.trim()).filter(Boolean).join(" ");
  }
  const tail = lines.filter((l) => l.trim()).slice(-IDLE_WINDOW);
  for (let i = tail.length - 1; i >= 0; i--) {
    const idle = IDLE.exec(tail[i]);
    if (idle) {
      out.idle = idle[1];
      break;
    }
  }
  return out;
}
