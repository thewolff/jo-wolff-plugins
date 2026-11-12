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
// While brb holds the session (`away`): the answer rule does not run (the human is away by their
// own word, so nothing they wrote is waiting), and the ask rule's reason says record the question
// with `ask` then `hold` instead of asking the human in plain words.
//
// Checked in that order; one block per Stop.
//
// The offer check (forcing.stopOfferRule) is separate: the Stop hook runs it in its second
// once-per-prompt slot, with the owed rule, whether or not a question is open. `offerSentences`
// finds sentences offering to do work (closed patterns P1 to P11 below, after removing code,
// double-quoted spans and `>` quote lines); `unrecordedOffers` drops those whose text matches a
// recorded question's `about` or `body`, so a second, different offer in the same reply still
// counts. A pattern joins the list only with a positive and a negative test sentence.

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

/** The ask rule's reason while brb holds the session: the human is away, so the question is recorded and held, not put to them. */
export function askAwayReason(cli = "ledger") {
  return `ledger: this turn has a question for the human but there is no open question row for this folder, and the human is away (brb). Record it with \`${cli} ask "<the question>" --name <short> --options <a,b> --default <a>\`, then \`${cli} hold <q-id>\`, then finish.`;
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
 * words, any case. Four shapes count:
 *
 *   - a permission or decision request on the agent: a modal on I/we ("should I", "shall we",
 *     "can I push?", "may I", "could we"), "want me to", "do/would you want/like/prefer/mind",
 *     "go ahead", "approve", "did you mean";
 *   - a confirmation: "is this right", "does that look right", "is it safe to", "is this a good
 *     time to", "ok to", or a short opener ("Ready to deploy?", "Okay to merge?");
 *   - an explicit choice: "would you prefer", "which … should", or an option list: set off by
 *     a comma or colon ("What should it be, alpha or beta?"), a whole sentence of options
 *     ("Alpha or beta?"), or a choice whose subject is the thing being configured ("Should
 *     the helper use local or remote storage?", "Use local or remote storage?": a sentence
 *     opening with should/shall/use/do we/which and carrying "or");
 *   - a wh-question (what/where/when/who/which/how) carrying a modal on I/we, "whether",
 *     "prefer" or an option list: "How should we proceed?", "Which option should we use?".
 *
 * What does not count: a "why" question ("Why should I store this twice?" is rhetorical); a
 * bare "which" or a loose "or" ("Which file holds the config?", "Are the logs compressed or
 * uncompressed?", "What do you want to build or check first?"); "do we know/have/see …"; and
 * "whether" or "proceed" embedded in a question about recorded facts ("Does the log say
 * whether the build failed?", "Did the deployment proceed without errors?"): a sentence
 * opening with does/did/is/are/was/were/has/have asks about a state unless it is a
 * confirmation shape above. This is a heuristic with a once-per-turn escape, not an
 * authority: an information request worded as a request ("Should the parser be deciding
 * this?") still bounces once.
 */
const MODAL_I_WE = /\b(?:shall|should|can|could|may|might|must|will|would) (?:i|we)\b(?! (?:know|have|see|understand|get|already|still|even|really|actually|expect|assume)\b)/i;
const REQUEST =
  /\b(?:want me to|go ahead|approve|did you mean|(?:do|would) you (?:want|need|prefer|mean|agree|approve|like|rather|mind)|do (?:i|we) (?!(?:know|have|see|understand|get|already|still|even|really|actually)\b)\w+|yes or no)\b/i;
const CONFIRM =
  /\b(?:ok(?:ay)? (?:to|if|with|for)|(?:is|was) (?:this|that|it) (?:ok(?:ay)?|right|correct|fine|good|enough|safe|what you|a good (?:time|idea|moment))|is it safe to|(?:does|do|did) (?:this|that|it|they|these|those) (?:look|sound|seem|feel) (?:right|good|ok(?:ay)?|correct|fine)|(?:look|sound)s? (?:right|good|ok(?:ay)?|correct) to you)\b/i;
const CONFIRM_OPENER = /^[\s*_#>`-]*(?:ready|ok(?:ay)?|good|fine|happy|all set|safe|alright|agreed|shall we|go)\b/i;
const PREFER_CHOICE = /\b(?:would you prefer|(?:do|would) you (?:prefer|rather)|which (?:one |option |way |of (?:these|those|them) )?(?:should|shall|do|would|will) (?:i|we|you))\b/i;
const OPTION_LIST = /[,:]\s*[^,:?]{1,60}\bor\b[^,:?]{1,60}\?$/i;
const LIST_ONLY = /^[\s*_#>`-]*[\w/.-]+(?:\s*,\s*[\w/.-]+)*\s+or\s+[\w/.-]+\?$/i;
const SUBJECT_CHOICE = /^[\s*_#>`-]*(?:should|shall|use|do we|which)\b[^,:?]*\bor\b[^,:?]*\?$/i;
const WH_START = /^[\s*_#>`-]*(?:what|where|when|who|whom|whose|which|how)\b/i;
// A why-question, at the start or after a lead-in ("I wonder, why do you prefer …?").
const WHY_START = /^[\s*_#>`-]*(?:why|how come)\b|[,:;]\s*(?:why|how come)\b/i;
const STATE_START = /^[\s*_#>`-]*(?:does|did|is|are|was|were|has|have|had)\b/i;

// In a wh-question "do you want" and "would you like" are open-ended ("What do you want to
// work on?"); only a modal on I/we, "whether", a preference or an option list decide.
const WH_REQUEST = /\b(?:whether|want me to)\b/i;

/** Whether one question sentence asks the human for a decision (see the shapes above). */
export function isDecisionAsk(sentence) {
  if (WHY_START.test(sentence)) return false;
  if (LIST_ONLY.test(sentence) || SUBJECT_CHOICE.test(sentence)) return true;
  if (WH_START.test(sentence)) return MODAL_I_WE.test(sentence) || WH_REQUEST.test(sentence) || PREFER_CHOICE.test(sentence) || OPTION_LIST.test(sentence);
  if (STATE_START.test(sentence)) return CONFIRM.test(sentence) || PREFER_CHOICE.test(sentence) || OPTION_LIST.test(sentence);
  return MODAL_I_WE.test(sentence) || REQUEST.test(sentence) || CONFIRM.test(sentence) || CONFIRM_OPENER.test(sentence) || PREFER_CHOICE.test(sentence) || OPTION_LIST.test(sentence);
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
 * @param opts.away                 brb holds the session (the human is away by their own word): no answer rule, and the ask rule says record and hold
 * @returns {null | { rule: 'stopAnswerRule'|'stopAskRule'|'stopDecisionRule', reason: string }}
 */
export function checkStop(message, { dueQuestions = [], sessionHasOpenQuestion = false, turnQuestions = 0, turnNotes = 0, forcing = {}, cli = "ledger", away = false } = {}) {
  if (forcing.stopAskRule !== false && !away && dueQuestions.length) return { rule: "stopAnswerRule", reason: answerReason(dueQuestions, cli) };
  const text = stripCode(message);
  const prose = stripQuoted(text);
  if (forcing.stopAskRule !== false && !sessionHasOpenQuestion && text.replace(/\s+/g, "").length >= MIN_CHARS && asksQuestion(prose) && asksDecision(prose)) {
    return { rule: "stopAskRule", reason: away ? askAwayReason(cli) : askReason(cli) };
  }
  if (forcing.stopDecisionRule !== false && turnNotes === 0 && turnQuestions === 0) {
    const phrase = decisionPhrase(prose, forcing.decisionPhrases);
    if (phrase) return { rule: "stopDecisionRule", reason: decisionReason(phrase, cli) };
  }
  return null;
}

// Verbs of perception and statement right after the modal: "I can see …", "I can tell …" report,
// they do not offer work.
const PERCEIVE = String.raw`(?:see|tell|say|know|notice|understand|confirm that|imagine|guess|think)\b`;
// Words P3 and P5 refuse right after the modal: offers of conversation, not of work.
const TALK = String.raw`(?:help|answer|explain|clarify|chat)\b`;

/**
 * The closed offer patterns, tested in this order on one trimmed sentence (apostrophes folded to
 * '). P1 to P7 and P11 are statements; P8 to P10 are offers worded as a question. P10 followed
 * only by `with that|it|this` or by nothing ("Should I go ahead with that?", "Shall I start?")
 * refers to a question already put and is not a new offer.
 */
export const OFFER_PATTERNS = Object.freeze([
  ["P1", new RegExp(String.raw`\b(?:i|we) (?:can|could) (?:also )?(?!${PERCEIVE})[^.!?]{1,80}\bnext[.!]?$`, "i")],
  ["P2", /\bsay the word\b/i],
  ["P3", new RegExp(String.raw`\bif you(?:'d| would)? (?:like|want)\b[^.!?]{0,30}\b(?:i'll|i will|i can|i could)\b(?! ${TALK})`, "i")],
  ["P4", /\blet me know if you(?:'d)? (?:like|want) me to\b/i],
  ["P5", new RegExp(String.raw`\b(?:i'm|i am|i'd be|i would be) happy to (?!${TALK})\w+`, "i")],
  ["P6", /\bi(?:'ll| will) [^.!?]{1,80}\bif you (?:want|like|say so|agree|approve)\b/i],
  ["P7", new RegExp(String.raw`\bnext,? (?:i|we) (?:can|could|would)\b(?! (?:also )?${PERCEIVE})`, "i")],
  ["P11", /\b(?:i|we) can (?:take|pick) (?:that|this|it) (?:on|up)\b/i],
  ["P8", /\bwant me to\b/i],
  ["P9", /\bwould you like me to\b/i],
  ["P10", /\b(?:shall|should|can|may) (?:i|we) (?:go ahead|start|build|run|add|write|fix|open|draft|kick off|dispatch|implement|make|do)\b/i],
]);

/** Whether a P10 match points back at the open question: only `with that|it|this`, or nothing, follows it. */
function p10RefersBack(sentence, match) {
  const after = sentence.slice(match.index + match[0].length).replace(/[\s.!?]+$/, "").trim();
  return after === "" || /^with (?:that|it|this)$/i.test(after);
}

/** The id of the first offer pattern `sentence` matches, or null. */
export function offerPattern(sentence) {
  const s = String(sentence ?? "").replace(/[‘’]/g, "'").trim();
  for (const [id, re] of OFFER_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    if (id === "P10" && p10RefersBack(s, m)) continue;
    return id;
  }
  return null;
}

/**
 * The sentences of `text` that offer to do work, each `{ sentence, pattern }`. Code, double-quoted
 * spans and lines starting with `>` are removed first; sentences are cut as `questionSentences`
 * cuts them, keeping every sentence, not only `?` ones.
 */
export function offerSentences(text) {
  const kept = stripCode(text)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  return stripQuoted(kept)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sentence) => ({ sentence, pattern: offerPattern(sentence) }))
    .filter((o) => o.pattern);
}

/** Text for matching: apostrophes folded, whitespace folded, lowercase, outer punctuation and quote marks trimmed. */
export function offerKey(text) {
  return String(text ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^[\s"'“”.,;:!?()*_`-]+|[\s"'“”.,;:!?()*_`-]+$/g, "");
}

/** The shortest recorded text that counts when found inside a longer offer sentence. */
export const OFFER_MATCH_FLOOR = 20;

/**
 * The offers no recorded question covers. A question covers an offer when the offer's text is
 * inside its `about` or `body`, or its `about` or `body` (at least OFFER_MATCH_FLOOR characters)
 * is inside the offer's text, both compared by `offerKey`.
 * @param offers    from offerSentences
 * @param questions candidates: { about, body }
 */
export function unrecordedOffers(offers, questions = []) {
  const texts = [];
  for (const q of questions) for (const t of [q.about, q.body]) if (t) texts.push(offerKey(t));
  return offers.filter(({ sentence }) => {
    const key = offerKey(sentence);
    if (!key) return false;
    return !texts.some((t) => (t && t.includes(key)) || (t.length >= OFFER_MATCH_FLOOR && key.includes(t)));
  });
}

const cut120 = (s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

/** The offer check's block reason: each unrecorded offer, the ask line that records it, and the way out. */
export function offerReason(offers, cli = "ledger") {
  const list = offers.map((o) => `- ${cut120(o.sentence)}`).join("\n");
  const one = offers.length === 1;
  return `ledger: this turn offers to do work the human has not approved, and no ledger question records ${one ? "the offer" : "these offers"}:\n${list}\nRecord ${one ? "it" : "each one"} with \`${cli} ask "<the question, in plain words>" --kind approval --name <short> --about "<the offer sentence, verbatim>"\`, then finish; ask in plain words without showing the human the q- id. If a sentence is not an offer, or repeats one already recorded, finish: the bounce is counted.`;
}

/** The offer check's reason while brb holds the session: record the offer and hold it. */
export function offerAwayReason(offers, cli = "ledger") {
  const list = offers.map((o) => `- ${cut120(o.sentence)}`).join("\n");
  const one = offers.length === 1;
  return `ledger: this turn offers to do work the human has not approved, no ledger question records ${one ? "the offer" : "these offers"}, and the human is away (brb):\n${list}\nRecord ${one ? "it" : "each one"} with \`${cli} ask "<the question, in plain words>" --kind approval --name <short> --about "<the offer sentence, verbatim>"\`, then \`${cli} hold <q-id>\`, then finish. If a sentence is not an offer, or repeats one already recorded, finish: the bounce is counted.`;
}
