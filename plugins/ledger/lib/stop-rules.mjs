// stop-rules.mjs — the checks the Stop hook runs on `last_assistant_message`, pure.
//
//   ask rule       (forcing.stopAskRule)       after removing fenced code blocks and inline
//                  code, some line ends with `?` AND the message names no q- id that is an open
//                  question in scope → block: the agent asked the human something without a
//                  ledger row. Messages under MIN_CHARS substantive characters are not checked.
//   decision rule  (forcing.stopDecisionRule)  after removing code and double-quoted spans, the
//                  message contains one of forcing.decisionPhrases (whole words, any case) AND
//                  no `note` was recorded in this turn → block: a decision was stated but not
//                  recorded. Quoted text is skipped so a reply that cites the human's words or
//                  a file does not count. No length floor: "Chose A." is a decision too.
//
// The ask rule is checked first; one block per Stop.

export const MIN_CHARS = 40;
const Q_ID_RE = /\bq-[a-z0-9]+\b/g;

/** The message without fenced blocks and inline code. */
export function stripCode(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/** The text without double-quoted spans ("…" and “…”) that start and end on one line. */
export function stripQuoted(text) {
  return String(text ?? "")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/\u201c[^\u201d\n]*\u201d/g, " ");
}

export function askReason(cli = "ledger") {
  return `ledger: this turn asks the human a question but names no open question row. Run \`${cli} ask "<the question>" --name <short> --options <a,b> --default <a>\` and end the message with the \`pending\` line for it (the q-id, the default, what each option allows).`;
}

export function decisionReason(phrase, cli = "ledger") {
  return `ledger: this turn states a decision ("${phrase}") but recorded no note. Run \`${cli} note "<what you decided and why>"\`, then finish.`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first of `phrases` present in `text` as whole words (case-insensitive), or null. */
export function decisionPhrase(text, phrases) {
  for (const phrase of phrases ?? []) {
    if (typeof phrase !== "string" || !phrase.trim()) continue;
    const re = new RegExp(`(^|[^A-Za-z])${escapeRe(phrase.trim()).replace(/\s+/g, "\\s+")}(?![A-Za-z])`, "i");
    if (re.test(text)) return phrase.trim();
  }
  return null;
}

/**
 * @param message               last_assistant_message
 * @param opts.openQuestionIds  ids of open questions in scope
 * @param opts.turnNotes        how many `note` rows this session recorded during this turn
 * @param opts.forcing          { stopAskRule, stopDecisionRule, decisionPhrases }
 * @returns {null | { rule: 'stopAskRule'|'stopDecisionRule', reason: string }}
 */
export function checkStop(message, { openQuestionIds = [], turnNotes = 0, forcing = {}, cli = "ledger" } = {}) {
  const text = stripCode(message);
  if (forcing.stopAskRule !== false && text.replace(/\s+/g, "").length >= MIN_CHARS) {
    const lines = text.split("\n").map((l) => l.trim());
    if (lines.some((l) => l.endsWith("?"))) {
      const named = new Set(text.match(Q_ID_RE) ?? []);
      if (!openQuestionIds.some((id) => named.has(id))) return { rule: "stopAskRule", reason: askReason(cli) };
    }
  }
  if (forcing.stopDecisionRule !== false && turnNotes === 0) {
    const phrase = decisionPhrase(stripQuoted(text), forcing.decisionPhrases);
    if (phrase) return { rule: "stopDecisionRule", reason: decisionReason(phrase, cli) };
  }
  return null;
}
