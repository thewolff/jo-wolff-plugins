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
//                  `?query` does not) AND the session has no open question row → block: the
//                  agent asked the human something without a ledger row. Messages under
//                  MIN_CHARS substantive characters are not checked.
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
  return `ledger: this turn asks the human a question but this session has no open question row. Run \`${cli} ask "<the question>" --name <short> --options <a,b> --default <a>\` first, then ask in plain words without showing the human the q- id; when they reply, record it with \`${cli} answer <q-id> <option>\`.`;
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
 * @param message                   last_assistant_message
 * @param opts.dueQuestions         open questions of this session asked before the human's latest prompt, newest first
 * @param opts.sessionHasOpenQuestion whether this session has any open question row
 * @param opts.turnQuestions        how many open questions this session asked during this turn
 * @param opts.turnNotes            how many `note` rows this session recorded during this turn
 * @param opts.forcing              { stopAskRule, stopDecisionRule, decisionPhrases }
 * @returns {null | { rule: 'stopAnswerRule'|'stopAskRule'|'stopDecisionRule', reason: string }}
 */
export function checkStop(message, { dueQuestions = [], sessionHasOpenQuestion = false, turnQuestions = 0, turnNotes = 0, forcing = {}, cli = "ledger" } = {}) {
  if (forcing.stopAskRule !== false && dueQuestions.length) return { rule: "stopAnswerRule", reason: answerReason(dueQuestions, cli) };
  const text = stripCode(message);
  const prose = stripQuoted(text);
  if (forcing.stopAskRule !== false && !sessionHasOpenQuestion && text.replace(/\s+/g, "").length >= MIN_CHARS && asksQuestion(prose)) {
    return { rule: "stopAskRule", reason: askReason(cli) };
  }
  if (forcing.stopDecisionRule !== false && turnNotes === 0 && turnQuestions === 0) {
    const phrase = decisionPhrase(prose, forcing.decisionPhrases);
    if (phrase) return { rule: "stopDecisionRule", reason: decisionReason(phrase, cli) };
  }
  return null;
}
