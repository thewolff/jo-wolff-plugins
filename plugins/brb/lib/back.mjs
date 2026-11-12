// back.mjs — how a hold ends and how the returned digest is then worked, one item at a time.
// Shared by the prompt hook (`back` typed, or sent by the band's Back button through
// `$.prompt.submit`, which runs the same hook; the item words below, typed or sent by the band).
//
// endHold(sessionId, env, at), under the session lock:
//   1. read away.json; null when home (nothing changes, the caller says "not away" or stays silent);
//   2. write checklist.json, the returned digest: one row per held line and closing ask with the
//      heading of its entry, none done, naming the archive path step 3 will use. A returned digest
//      still open from an earlier hold keeps its rows, numbers and ticks, and the new rows follow
//      (lib/state.mjs mergeChecklist); a hold that held nothing leaves an open one as it is and
//      writes none otherwise;
//   3. move digest.md to archive/<ts>.md (the record; nothing in it is lost);
//   4. remove away.json.
// Each step that throws leaves the earlier ones done and the later ones not, and the hold on, so a
// retried `back` loses nothing: a failed step 2 has changed nothing (the digest is still in place);
// a failed step 3 leaves the rows written and the digest in place, and the retry adds only the
// items past checklist.json `taken` (the count of this hold's items, `since`, already rows); a
// failed step 4 leaves no digest, so the retry adds nothing and removes away.json.
// Under BRB_HARNESS=omp step 2 and the list are skipped: `text` is the whole digest, as in 0.5.0,
// because OMP never routes the item words here.
// Returns { away, at, archived, checklist, text, agentText }: `text` is the person-facing block
// (`brb: hold cleared; digest archived to <path>.`, then the numbered list, one line per row, and
// how to work it), `agentText` the same under lib/text.mjs backInstruction, for the agent.
//
// The returned digest is closed only by tickItem ticking its last row or by clearReturned, which
// returns every row not done in full for the agent to reply with before the file goes: no path
// removes checklist.json with an unticked row unshown. A block or an item longer than a hook's
// context carries (lib/text.mjs REASON_CAP) is written whole to export/<ts>-<what>.md first
// (lib/state.mjs writeExport: fsync'd and its size checked) and the message is cut and points at
// it by absolute path; when that write fails clearReturned removes nothing and says so.

import { existsSync } from "node:fs";

import { archiveDigest, archiveTarget, checklistPath, clearAway, clearChecklist, digestEntries, digestHeader, digestPath, freshChecklist, renderDigest, mergeChecklist, readAway, readChecklist, readDigest, tickChecklistItem, withAwayLock, writeChecklist, writeExport } from "./state.mjs";
import { CLEAR_KEPT_INSTRUCTION, REASON_CAP, backDigestInstruction, backInstruction, cappedReason, clearBlock, clearExportFailedText, clearExportedInstruction, clearInstruction, cutToExport, digestList, itemBlock, itemCutInstruction, itemExportFailedText, itemInstruction, listFooter, noItemText, tickText } from "./text.mjs";

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
    if (env.BRB_HARNESS === "omp") {
      const archived = archiveDigest(sessionId, env, at);
      // OMP's adapter never passes the item words to this hook, so a list would hide items for good.
      clearAway(sessionId, env);
      const text = cappedReason(`brb: hold cleared${archived ? `; digest archived to ${archived}` : ""}.`, renderDigest(away, raw, env), archived ?? digestPath(sessionId, env));
      return { away, at, archived, checklist: null, text, agentText: `${backDigestInstruction(away, at)}\n\n${text}` };
    }
    const target = existsSync(digestPath(sessionId, env)) ? archiveTarget(sessionId, env, at) : null;
    const open = readChecklist(sessionId, env);
    // A `back` whose archive step failed already wrote this hold's first `taken` items as rows.
    const again = open && open.since === away.since ? Math.min(open.taken ?? 0, entries.length) : 0;
    const fresh = freshChecklist({ at, since: away.since, note: away.note, archived: target ? [target] : [], items: entries.slice(again) });
    let checklist = open;
    if (again) checklist = { ...open, archived: [...open.archived.filter((a) => existsSync(a)), ...fresh.archived], items: [...open.items, ...fresh.items], taken: entries.length };
    else if (fresh.items.length) checklist = { ...mergeChecklist(open, fresh), taken: entries.length };
    if (checklist !== open) writeChecklist(sessionId, checklist, env);
    const archived = target ? archiveDigest(sessionId, env, at, target) : null;
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
 * Returns `{ agentText, systemMessage? }`, or null when no returned digest is open. Changes no
 * row. An item longer than REASON_CAP is written whole to an export and `agentText` carries its
 * start and the export's path; when that write fails it points at checklist.json instead, and
 * `systemMessage` says so.
 */
export function showItem(sessionId, n, env) {
  const checklist = withAwayLock(sessionId, env, () => readChecklist(sessionId, env));
  if (!checklist) return null;
  const total = checklist.items.length;
  const item = checklist.items[n - 1];
  if (!item) return { agentText: noItemText(n, total) };
  const block = itemBlock(item, n, total);
  if (block.length <= REASON_CAP) return { agentText: `${itemInstruction(n)}\n\n${block}` };
  const [head] = block.split("\n");
  try {
    const path = writeExport(sessionId, `item-${n}`, `${block}\n`, env);
    return { agentText: `${itemCutInstruction(n, path)}\n\n${cutToExport(head, item.text, path)}` };
  } catch (err) {
    const where = checklistPath(sessionId, env);
    return { agentText: `${itemCutInstruction(n, where)}\n\n${cutToExport(head, item.text, where)}`, systemMessage: itemExportFailedText(n, err?.message ?? String(err), where) };
  }
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
 * each, then the file is removed. Returns `{ text, agentText, open, exported?, kept? }`, or null
 * when none is open. A block longer than REASON_CAP is written whole to an export first
 * (`exported`, its path) and `text` is cut and points at it; when that write fails the file stays
 * (`kept: true`) and `text` says so.
 */
export function clearReturned(sessionId, env) {
  return withAwayLock(sessionId, env, () => {
    const checklist = readChecklist(sessionId, env);
    if (!checklist) return null;
    const open = openNumbers(checklist).length;
    const head = "brb: returned digest closed.";
    const block = clearBlock(checklist);
    const whole = `${head}\n\n${block}`;
    if (whole.length <= REASON_CAP) {
      clearChecklist(sessionId, env);
      return { open, text: whole, agentText: `${clearInstruction(open)}\n\n${whole}` };
    }
    let exported;
    try {
      exported = writeExport(sessionId, "clear", `${whole}\n`, env);
    } catch (err) {
      const text = clearExportFailedText(open, err?.message ?? String(err));
      return { open, kept: true, text, agentText: `${CLEAR_KEPT_INSTRUCTION}\n\n${text}` };
    }
    const text = cutToExport(head, block, exported);
    clearChecklist(sessionId, env);
    return { open, exported, text, agentText: `${open ? clearExportedInstruction(open, exported) : clearInstruction(0)}\n\n${text}` };
  });
}
