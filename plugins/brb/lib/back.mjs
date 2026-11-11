// back.mjs — how a hold ends and how the returned digest is then worked, one item at a time.
// Shared by the prompt hook (`back` typed, or sent by the band's Back button through
// `$.prompt.submit`, which runs the same hook; the item words below, typed or sent by the band).
//
// endHold(sessionId, env, at), under the session lock:
//   1. read away.json; null when home (nothing changes, the caller says "not away" or stays silent);
//   2. move digest.md to archive/<ts>.md (the record; nothing in it is lost);
//   3. write checklist.json, the returned digest: one row per held line and closing ask with the
//      heading of its entry, none done. A returned digest still open from an earlier hold keeps
//      its rows, numbers and ticks, and the new rows follow (lib/state.mjs mergeChecklist); a hold
//      that held nothing leaves an open one as it is and writes none otherwise;
//   4. remove away.json.
// Under BRB_HARNESS=omp steps 3 and the list are skipped: `text` is the whole digest, as in 0.5.0,
// because OMP never routes the item words here.
// Returns { away, at, archived, checklist, text, agentText }: `text` is the person-facing block
// (`brb: hold cleared; digest archived to <path>.`, then the numbered list, one line per row, and
// how to work it), `agentText` the same under lib/text.mjs backInstruction, for the agent.
//
// The returned digest is closed only by tickItem ticking its last row or by clearReturned, which
// returns every row not done in full for the agent to reply with before the file goes: no path
// removes checklist.json with an unticked row unshown.

import { archiveDigest, checklistPath, clearAway, clearChecklist, digestEntries, digestHeader, digestPath, freshChecklist, renderDigest, mergeChecklist, readAway, readChecklist, readDigest, tickChecklistItem, withAwayLock, writeChecklist } from "./state.mjs";
import { backDigestInstruction, backInstruction, cappedReason, clearBlock, clearInstruction, digestList, itemBlock, itemInstruction, listFooter, noItemText, tickText } from "./text.mjs";

/**
 * @param {string} sessionId
 * @param {object} env
 * @param {string} at  ISO time the hold ends
 * @returns {object|null}  null when the session was home
 */
export function endHold(sessionId, env, at = new Date().toISOString()) {
  return withAwayLock(sessionId, env, () => {
    const away = readAway(sessionId, env);
    if (!away) return null;
    const raw = readDigest(sessionId, env);
    const entries = digestEntries(raw);
    const archived = archiveDigest(sessionId, env, at);
    if (env.BRB_HARNESS === "omp") {
      // OMP's adapter never passes the item words to this hook, so a list would hide items for good.
      clearAway(sessionId, env);
      const text = cappedReason(`brb: hold cleared${archived ? `; digest archived to ${archived}` : ""}.`, renderDigest(away, raw, env), archived ?? digestPath(sessionId, env));
      return { away, at, archived, checklist: null, text, agentText: `${backDigestInstruction(away, at)}\n\n${text}` };
    }
    const fresh = freshChecklist({ at, since: away.since, note: away.note, archived: archived ? [archived] : [], items: entries });
    const open = readChecklist(sessionId, env);
    const checklist = entries.length ? mergeChecklist(open, fresh) : open;
    if (entries.length) writeChecklist(sessionId, checklist, env);
    clearAway(sessionId, env);
    const header = digestHeader(away, env);
    const body = checklist?.items.length ? `${digestList(checklist)}\n\n${listFooter(checklist)}` : "(nothing held)";
    const text = cappedReason(`brb: hold cleared${archived ? `; digest archived to ${archived}` : ""}.`, `${header}\n\n${body}`, archived ?? digestPath(sessionId, env));
    return { away, at, archived, checklist, text, agentText: `${backInstruction(away, at)}\n\n${text}` };
  });
}

/** The 1-based numbers of the rows not done. */
const openNumbers = (checklist) => checklist.items.flatMap((item, i) => (item.done ? [] : [i + 1]));

/**
 * Item `n` (1-based) of the open returned digest, for the agent to show in full and work.
 * Returns `{ agentText }`, or null when no returned digest is open. Changes nothing.
 */
export function showItem(sessionId, n, env) {
  const checklist = withAwayLock(sessionId, env, () => readChecklist(sessionId, env));
  if (!checklist) return null;
  const total = checklist.items.length;
  const item = checklist.items[n - 1];
  if (!item) return { agentText: noItemText(n, total) };
  return { agentText: `${itemInstruction(n)}\n\n${itemBlock(item, n, total)}` };
}

/**
 * Tick item `n` (1-based) done. Ticking the last open row closes the returned digest (the file is
 * removed; the archive keeps the digest). Returns `{ agentText, closed }`, or null when none is open.
 */
export function tickItem(sessionId, n, env) {
  return withAwayLock(sessionId, env, () => {
    const checklist = readChecklist(sessionId, env);
    if (!checklist) return null;
    const total = checklist.items.length;
    const ticked = tickChecklistItem(sessionId, n - 1, env);
    if (!ticked) return { agentText: noItemText(n, total), closed: false };
    return { agentText: tickText({ n, item: ticked.item, already: ticked.already, closed: ticked.closed, open: openNumbers(ticked.checklist) }), closed: ticked.closed };
  });
}

/**
 * Close the returned digest on `brb clear`: every row not done in full, the done rows one line
 * each, then the file is removed. Returns `{ text, agentText, open }`, or null when none is open.
 * `text` is capped (lib/text.mjs cappedReason) and points at the last archive when cut.
 */
export function clearReturned(sessionId, env) {
  return withAwayLock(sessionId, env, () => {
    const checklist = readChecklist(sessionId, env);
    if (!checklist) return null;
    const open = openNumbers(checklist).length;
    const text = cappedReason("brb: returned digest closed.", clearBlock(checklist), checklist.archived.at(-1) ?? checklistPath(sessionId, env));
    clearChecklist(sessionId, env);
    return { open, text, agentText: `${clearInstruction(open)}\n\n${text}` };
  });
}
