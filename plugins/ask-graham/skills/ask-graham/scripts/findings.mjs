// findings.mjs — what one ask-graham reply decided, as the findings file other plugins read
// (README "Findings on disk"). Pure: parseFindings reads a reply's text and returns the record's
// fields, or null when the reply carries neither a `**Verdict:**` nor a `**Structure check:**`
// line. The Claude Code Stop hook (hooks/ask-graham-stop.mjs) adds sessionId, writtenAt and cwd and
// writes it.
//
// LABELS. A label counts on a line that starts with it, optionally after a list marker or a
// heading, written bold (`**Label:**`, `**Label**:`, or with `__`), case-sensitive. Text inside a
// code fence does not count (a template quoted in a fence is not an answer). The first line with
// a label is the one read. A value keeps its text; `*`, `_`, backticks and quotes wrapped around
// it are dropped, as the 0.8.0 Verdict and Alternative patterns tolerate them.

import { stripFences, VERDICTS } from "./verdict.mjs";

export const FINDINGS_VERSION = 1;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value on the first line labelled `label`, trimmed (possibly ""), or null without one. */
export function labelValue(text, label) {
  const re = new RegExp(
    String.raw`^[ \t]*(?:[-*+>][ \t]+|#{1,6}[ \t]+)?(?:\*\*|__)${escape(label)}(?::(?:\*\*|__)|(?:\*\*|__):)[ \t]*(.*)$`,
    "m",
  );
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

const WRAP = /^[*_`"'“”‘’]+|[*_`"'“”‘’]+$/g;

/** A value without the emphasis, backticks or quotes wrapped around it. */
export const unwrap = (s) => s.replace(WRAP, "").trim();

// The forms an Alternative line takes when nothing beats the pattern (the 0.8.0 eval's list).
const NONE_FORM = /^(?:none|nothing|no better|n\/?a|not a technical ask)(?![a-z0-9])/i;

/** True when an Alternative value says nothing beats the pattern. */
export const isNoneForm = (value) => NONE_FORM.test(unwrap(value));

const VERDICT_HEAD = new RegExp(
  String.raw`^(?:\*\*|__|\*|_|\x60)?(` + VERDICTS.map((v) => escape(v).replace("'", "['’]")).join("|") + String.raw`)(?:\*\*|__|\*|_|\x60)?(?=$|\s|\p{P})`,
  "iu",
);

/** `{ verdict, why }` from a Verdict line's value: the verdict as VERDICTS spells it, or null. */
export function splitVerdict(value) {
  const m = VERDICT_HEAD.exec(value);
  if (!m) return { verdict: null, why: unwrap(value) || null };
  const said = m[1].toLowerCase().replace("’", "'");
  const why = value.slice(m[0].length).replace(/^[\s.,;:!—–-]+/, "").trim();
  return { verdict: VERDICTS.find((v) => v === said) ?? null, why: unwrap(why) || null };
}

// The Found line's text, then each list item directly under it (blank lines before the first
// item allowed), up to the first line that is neither.
function foundItems(text) {
  const lines = text.split("\n");
  const head = /^[ \t]*(?:[-*+>][ \t]+|#{1,6}[ \t]+)?(?:\*\*|__)Found(?::(?:\*\*|__)|(?:\*\*|__):)[ \t]*(.*)$/;
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return [];
  const out = [];
  const first = head.exec(lines[at])[1].trim();
  if (first) out.push(first);
  let i = at + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  for (; i < lines.length; i++) {
    const item = /^[ \t]*[-*+][ \t]+(\S.*)$/.exec(lines[i]);
    if (!item) break;
    out.push(item[1].trim());
  }
  return out;
}

/**
 * The findings of one reply, or null when it has no `**Verdict:**` or `**Structure check:**` line
 * (or is not a string). Never throws on a string.
 * Shape: { kind, ask, verdict, alternative, alternatives: [{ design, chosen }], found }.
 */
export function parseFindings(reply) {
  if (typeof reply !== "string") return null;
  const text = stripFences(reply.replace(/\r\n/g, "\n"));
  const structure = labelValue(text, "Structure check");
  const verdictLine = labelValue(text, "Verdict");
  if (structure === null && verdictLine === null) return null;
  const kind = structure !== null ? "structure-check" : "verdict";
  const { verdict, why } = verdictLine === null ? { verdict: null, why: null } : splitVerdict(verdictLine);
  const alternative = labelValue(text, "Alternative") || null;
  const alternatives = [];
  if (kind === "verdict" && why) alternatives.push({ design: why, chosen: true });
  if (alternative && !isNoneForm(alternative)) alternatives.push({ design: unwrap(alternative), chosen: false });
  return {
    kind,
    ask: labelValue(text, "Ask") || null,
    verdict: kind === "verdict" ? verdict : null,
    alternative,
    alternatives,
    found: foundItems(text),
  };
}
