// sections.mjs — what the Stop hook reads out of the agent's final message while Jo is away.
//
// The away instruction (lib/text.mjs) asks the agent for three things, and this file finds them:
//   1. a `Needs you` section: a line that is exactly the heading (`## Needs you`, `**Needs you**`,
//      `Needs you:`; any heading depth, bold or not, a trailing colon or not, any case) and the
//      lines under it up to the next heading, bold label line or horizontal rule;
//   2. `on fire:` lines: a line that starts with `on fire` (after an optional bullet or number
//      and an optional `**`), any case, anywhere in the message — the costly failure is a fire
//      that waited, so the whole message is read, not only the section;
//   3. a closing `idle: <why>` line: the last non-blank line of the message.
// The closing ask, when the message has one, travels into the digest too: a `Closing ask`
// section (same heading rule), or a line that starts with `Closing ask:`.
//
// Same idea as i-have-audhd's checks/sections.mjs (a message split at label lines), written
// for these three markers; nothing is imported from that plugin. Pure; never throws on a string.

/** `/^\s*(\*\*)?on fire\b/i`, with an optional list marker in front: `- **on fire:** …`, `1. on fire …`. */
export const ON_FIRE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)?\s*on[ -]fire\b/i;

const IDLE = /^\s*(?:\*\*|__)?\s*idle\s*:\s*(?:\*\*|__)?\s*(.*?)\s*(?:\*\*|__)?\s*$/i;
const HEADING = /^\s*#{1,6}\s+\S/;
const BOLD_LABEL = /^\s*(?:\*\*|__)[^*_].*?(?:\*\*|__):?\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** The heading's words when `line` is exactly a heading for them, else null. */
function headingText(line) {
  const m = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?\s*([^*_#].*?)\s*(?:\*\*|__)?\s*:?\s*$/.exec(line);
  if (!m) return null;
  return m[1].replace(/\s*:\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const isNeedsYou = (line) => headingText(line) === "needs you";
const isClosingAsk = (line) => headingText(line) === "closing ask";
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
 *   held        the section's non-blank lines that are not on fire, trimmed, in order
 *   onFire      every on-fire line in the message, trimmed, in order, no repeats
 *   closingAsk  the closing ask's text, or null
 *   idle        the `idle:` line's reason ("" for a bare `idle:`), or null when the message does not end with one
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
      const key = normalizeLine(line);
      if (!fire.has(key)) {
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
    out.held = sectionLines.map((l) => l.trim()).filter((l) => l && !IDLE.test(l) && !FENCE.test(l));
  }
  if (out.closingAsk === null && closingLines.some((l) => l.trim())) {
    out.closingAsk = closingLines.map((l) => l.trim()).filter(Boolean).join(" ");
  }
  const last = [...lines].reverse().find((l) => l.trim());
  const idle = last ? IDLE.exec(last) : null;
  if (idle) {
    out.idle = idle[1];
    // An idle line typed inside the section is not an ask.
    out.held = out.held.filter((l) => !IDLE.test(l));
  }
  return out;
}
