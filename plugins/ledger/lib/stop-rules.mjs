// stop-rules.mjs — the one check the Stop hook runs on `last_assistant_message`, pure.
//
//   ask rule   (forcing.stopAskRule)   after removing fenced code blocks and inline code, some
//              line ends with `?` AND the message names no q- id that is an open question in
//              scope → block: the agent asked the human something without a ledger row.
//
// Messages shorter than MIN_CHARS substantive characters are never checked.

export const MIN_CHARS = 40;
const Q_ID_RE = /\bq-[a-z0-9]+\b/g;

/** The message without fenced blocks and inline code. */
export function stripCode(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

export function askReason(cli = "ledger") {
  return `ledger: this turn asks the human a question but names no open question row. Run \`${cli} ask "<the question>" --name <short> --options <a,b> --default <a>\` and end the message with the \`pending\` line for it (the q-id, the default, what each option allows).`;
}

/**
 * @param message            last_assistant_message
 * @param opts.openQuestionIds  ids of open questions in scope
 * @param opts.forcing          { stopAskRule }
 * @returns {null | { rule: 'stopAskRule', reason: string }}
 */
export function checkStop(message, { openQuestionIds = [], forcing = {}, cli = "ledger" } = {}) {
  if (forcing.stopAskRule === false) return null;
  const text = stripCode(message);
  if (text.replace(/\s+/g, "").length < MIN_CHARS) return null;
  const lines = text.split("\n").map((l) => l.trim());
  if (!lines.some((l) => l.endsWith("?"))) return null;
  const named = new Set(text.match(Q_ID_RE) ?? []);
  if (openQuestionIds.some((id) => named.has(id))) return null;
  return { rule: "stopAskRule", reason: askReason(cli) };
}
