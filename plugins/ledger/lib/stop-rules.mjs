// stop-rules.mjs — the checks the Stop hook runs, pure. The hook reads the store and passes in
// what each rule needs; nothing here reads a q- id out of the reply.
//
//   answer rule    (forcing.stopAskRule)       the session has open questions asked before the
//                  human's latest prompt (`dueQuestions`) → block: the human has replied, so the
//                  agent records the answer from that reply (`answer <q-id> <option>`) before it
//                  finishes. The ids go to the agent only; the human never has to type one.
//   ask rule       (forcing.stopAskRule)       after removing fenced code blocks, inline code
//                  and double-quoted spans, some sentence ends with `?` (a `?` at the end of a
//                  line or followed by a space: "Should I …? I'd say yes." counts; a URL's
//                  `?query` does not) AND that sentence asks for a decision (a request such as
//                  "should I", "do you want", "ready to", an explicit option list, or a
//                  wh-question carrying one — see isDecisionAsk; a greeting or an information
//                  request, "What are we working on?", needs no row) AND no
//                  question is open for the folder (this session's, or one in the cwd or a
//                  parent) → block: the agent asked the human something without a ledger row.
//                  Messages under MIN_CHARS substantive characters are not checked.
//   decision rule  (forcing.stopDecisionRule)  after removing code and double-quoted spans, the
//                  message contains one of forcing.decisionPhrases (whole words, any case) AND
//                  no `note` was recorded in this turn AND no question was asked in this turn →
//                  block: a decision was stated but not recorded. Quoted text is skipped so a
//                  reply that cites the human's words or a file does not count; a question asked
//                  this turn means the phrase is the stated default ("if you don't answer, I'll
//                  go with alpha"), which the question row already records. No length floor:
//                  "Chose A." is a decision too.
//
// Checked in that order; one block per Stop.

export const MIN_CHARS = 40;

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
  return `ledger: this turn asks the human a question but there is no open question row for this folder. Run \`${cli} ask "<the question>" --name <short> --options <a,b> --default <a>\` first, then ask in plain words without showing the human the q- id; when they reply, record it with \`${cli} answer <q-id> <option>\`.`;
}

/** @param questions open questions, newest first: { id, name, body } */
export function answerReason(questions, cli = "ledger") {
  const list = questions.map((q) => `${q.id} (${q.name}): ${q.body}`).join("\n");
  const one = questions.length === 1;
  return `ledger: the human has written since you asked ${one ? "this question" : "these questions"}, and ${one ? "it has" : "they have"} no answer recorded:\n${list}\nTake the answer from the human's latest message and run \`${cli} answer <q-id> <option>\` for ${one ? "it" : "each"} (or \`${cli} withdraw <q-id>\` if they set it aside), then finish. Do not show the q- id to the human.`;
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

/** Whether `text` asks something: a `?` at the end of a line or followed by whitespace. */
export function asksQuestion(text) {
  return /\?(\s|$)/m.test(String(text ?? ""));
}

/**
 * The sentences of `text` that end with `?` (a `?` at the end of a line or followed by
 * whitespace), each trimmed. Sentences are cut at `.`, `!` or `?` followed by whitespace, and at
 * line breaks.
 */
export function questionSentences(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /\?$/.test(s));
}

/**
 * What makes a question one the human has to decide, tested on one question sentence, whole
 * words, any case. Three shapes count:
 *
 *   - a decision, permission or confirmation request: "should I", "shall we", "do you want",
 *     "want me to", "would you like", "is this right", "ok to", "go ahead", "proceed",
 *     "approve", or a short confirmation opener ("Ready to deploy?", "Okay to merge?");
 *   - an explicit choice: "whether", "do/would you prefer", or an option list, either set off
 *     by a comma or colon ("What should it be, alpha or beta?", "put it: plugins/a or
 *     plugins/b?") or the whole sentence ("Alpha or beta?");
 *   - a wh-question (what/where/when/who/which/how) that carries one of those: "How should we
 *     proceed?", "Which do you prefer?". Bare "which" and a loose "or" are not enough: "Which
 *     file contains the config?", "Are the logs compressed or uncompressed?", "What do you want
 *     to build or check first?" and "What are we working on?" ask for information.
 *
 * "Why" questions never count: "Why should I store this twice?" is rhetorical, not a request.
 * "Do we know …", "do we have …" and the like ask for information and are excluded from "do we".
 * This is a heuristic with a once-per-turn escape, not an authority: an information request
 * worded like a decision ("Should the parser be deciding this?") still bounces once.
 */
const DECISION_REQUEST =
  /\b(?:whether|approve|proceed|go ahead|want me to|(?:shall|should|could|may|must|will) (?:i|we)|do (?:i|we) (?!(?:know|have|see|understand|get|already|still|even|really|actually)\b)\w+|(?:do|would) you (?:want|need|prefer|mean|agree|approve|like|rather|mind)|did you mean|yes or no|ok(?:ay)? (?:to|if|with|for)|(?:is|was) (?:this|that|it) (?:ok(?:ay)?|right|correct|fine|good|enough|what you)|(?:look|sound)s? (?:right|good|ok(?:ay)?|correct))\b/i;
const CONFIRM_OPENER = /^[\s*_#>`-]*(?:ready|ok(?:ay)?|good|fine|happy|all set|safe|alright|agreed|shall we|go)\b/i;
const OPTION_LIST = /[,:]\s*[^,:?]{1,60}\bor\b[^,:?]{1,60}\?$/i;
const WH_START = /^[\s*_#>`-]*(?:what|where|when|who|whom|whose|which|how)\b/i;
const WHY_START = /^[\s*_#>`-]*(?:why|how come)\b/i;
const LIST_ONLY = /^[\s*_#>`-]*[\w/.-]+(?:\s*,\s*[\w/.-]+)*\s+or\s+[\w/.-]+\?$/i;

// In a wh-question "do you want" and "would you like" are open-ended ("What do you want to
// work on?"); only a modal on I/we, "whether", "prefer", "want me to" or an option list decide.
const WH_REQUEST = /\b(?:whether|want me to|(?:shall|should|could|may|must|will) (?:i|we)|(?:do|would) you prefer|would you rather)\b/i;

/** Whether one question sentence asks the human for a decision (see DECISION_REQUEST). */
export function isDecisionAsk(sentence) {
  if (WHY_START.test(sentence)) return false;
  if (LIST_ONLY.test(sentence)) return true;
  if (WH_START.test(sentence)) return WH_REQUEST.test(sentence) || OPTION_LIST.test(sentence);
  return DECISION_REQUEST.test(sentence) || CONFIRM_OPENER.test(sentence) || OPTION_LIST.test(sentence);
}

/** Whether some question sentence in `text` asks the human for a decision. */
export function asksDecision(text) {
  return questionSentences(text).some(isDecisionAsk);
}

/**
 * @param message                   last_assistant_message
 * @param opts.dueQuestions         open questions of this session asked before the human's latest prompt, newest first
 * @param opts.sessionHasOpenQuestion whether a question is open for the folder (this session's, or one in scope for the cwd)
 * @param opts.turnQuestions        how many open questions this session asked during this turn
 * @param opts.turnNotes            how many `note` rows this session recorded during this turn
 * @param opts.forcing              { stopAskRule, stopDecisionRule, decisionPhrases }
 * @returns {null | { rule: 'stopAnswerRule'|'stopAskRule'|'stopDecisionRule', reason: string }}
 */
export function checkStop(message, { dueQuestions = [], sessionHasOpenQuestion = false, turnQuestions = 0, turnNotes = 0, forcing = {}, cli = "ledger" } = {}) {
  if (forcing.stopAskRule !== false && dueQuestions.length) return { rule: "stopAnswerRule", reason: answerReason(dueQuestions, cli) };
  const text = stripCode(message);
  const prose = stripQuoted(text);
  if (forcing.stopAskRule !== false && !sessionHasOpenQuestion && text.replace(/\s+/g, "").length >= MIN_CHARS && asksQuestion(prose) && asksDecision(prose)) {
    return { rule: "stopAskRule", reason: askReason(cli) };
  }
  if (forcing.stopDecisionRule !== false && turnNotes === 0 && turnQuestions === 0) {
    const phrase = decisionPhrase(prose, forcing.decisionPhrases);
    if (phrase) return { rule: "stopDecisionRule", reason: decisionReason(phrase, cli) };
  }
  return null;
}
