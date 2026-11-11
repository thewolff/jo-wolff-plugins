// back.mjs — the one way a hold ends, shared by the prompt hook (`back` typed, or sent by the
// band's Back button through `$.prompt.submit`, which runs the same hook).
//
// endHold(sessionId, env, at), under the session lock:
//   1. read away.json; null when home (nothing changes, the caller says "not away" or stays silent);
//   2. render the digest (lib/state.mjs renderDigest) and move digest.md to archive/<ts>.md;
//   3. write checklist.json from the digest's items (lib/state.mjs digestItems: one row per held
//      line and closing ask, none done), so the band above the prompt keeps the list on screen
//      after the hold ends; a hold that held nothing writes no checklist and removes a stale one;
//   4. remove away.json.
// Returns { away, at, archived, digest, text, items }: `text` is the person-facing block
// (`brb: hold cleared; digest archived to <path>.` then the digest, capped at lib/text.mjs
// REASON_CAP), `agentText` the same under lib/text.mjs backInstruction, for the agent.

import { archiveDigest, clearAway, clearChecklist, digestItems, digestPath, freshChecklist, readAway, readDigest, renderDigest, withAwayLock, writeChecklist } from "./state.mjs";
import { backInstruction, cappedReason } from "./text.mjs";

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
    const body = readDigest(sessionId, env);
    const digest = renderDigest(away, body, env);
    const items = digestItems(body);
    const archived = archiveDigest(sessionId, env, at);
    if (items.length) writeChecklist(sessionId, freshChecklist({ at, since: away.since, note: away.note, items }), env);
    else clearChecklist(sessionId, env);
    clearAway(sessionId, env);
    const text = cappedReason(`brb: hold cleared${archived ? `; digest archived to ${archived}` : ""}.`, digest, archived ?? digestPath(sessionId, env));
    return { away, at, archived, digest, items, text, agentText: `${backInstruction(away, at)}\n\n${text}` };
  });
}
