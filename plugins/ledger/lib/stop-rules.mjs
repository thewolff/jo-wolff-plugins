// stop-rules.mjs — the two checks the Stop hook runs on `last_assistant_message`, pure.
//
//   ask rule   (forcing.stopAskRule)   after removing fenced code blocks and inline code, some
//              line ends with `?` AND the message names no q- id that is an open question in
//              scope → block: the agent asked the human something without a ledger row.
//   done rule  (forcing.stopDoneRule)  a line names an OPEN wl- id and, on the same line, a
//              completion word (done, complete, completed, finished, shipped, landed, merged,
//              closed) → block: the workload reads as finished but is still open.
//
// Messages shorter than MIN_CHARS substantive characters are never checked.

export const MIN_CHARS = 40;
export const DONE_WORDS = ["done", "complete", "completed", "finished", "shipped", "landed", "merged", "closed"];
const DONE_RE = new RegExp(`\\b(${DONE_WORDS.join("|")})\\b`, "i");
const Q_ID_RE = /\bq-[a-z0-9]+\b/g;
const WL_ID_RE = /\bwl-[a-z0-9]+\b/g;

/** The message without fenced blocks and inline code. */
export function stripCode(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

export function askReason(cli = "ledger") {
  return `ledger: this turn asks the human a question but names no open question row. Run \`${cli} ask "<the question>" --name <short> --options <a,b> --default <a>\` and end the message with the \`pending\` line for it (the q-id, the default, what each option allows).`;
}

export function doneReason(wlId, cli = "ledger") {
  return `ledger: ${wlId} reads as finished but is still open. \`${cli} close ${wlId} <reason>\` or \`${cli} park ${wlId} <reason>\`, or keep working and say so.`;
}

/**
 * @param message            last_assistant_message
 * @param opts.openQuestionIds  ids of open questions in scope
 * @param opts.isOpenWorkload   (wlId) → boolean
 * @param opts.forcing          { stopAskRule, stopDoneRule }
 * @returns {null | { rule: 'stopAskRule'|'stopDoneRule', reason: string }}
 */
export function checkStop(message, { openQuestionIds = [], isOpenWorkload = () => false, forcing = {}, cli = "ledger" } = {}) {
  const text = stripCode(message);
  if (text.replace(/\s+/g, "").length < MIN_CHARS) return null;
  const lines = text.split("\n").map((l) => l.trim());

  if (forcing.stopAskRule !== false) {
    const asks = lines.some((l) => l.endsWith("?"));
    if (asks) {
      const named = new Set(text.match(Q_ID_RE) ?? []);
      const hasRow = openQuestionIds.some((id) => named.has(id));
      if (!hasRow) return { rule: "stopAskRule", reason: askReason(cli) };
    }
  }

  if (forcing.stopDoneRule !== false) {
    for (const line of lines) {
      if (!DONE_RE.test(line)) continue;
      for (const wl of line.match(WL_ID_RE) ?? []) {
        if (isOpenWorkload(wl)) return { rule: "stopDoneRule", reason: doneReason(wl, cli) };
      }
    }
  }
  return null;
}
