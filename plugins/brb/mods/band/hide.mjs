// hide.mjs — which transcript rows the brb mod draws as one dim line while Jo is away, and the
// fixed text it tells the agent while away. Pure: register.mjs calls it from its `ui.render`,
// `tool.call` and `prompt.section` hooks; `node --test` calls it with plain data.
//
// The away window. The row sites (`AssistantMessage`, `ToolUse`, `ToolResult`, `ToolGroup`)
// carry no time: `e.props` is the text or the tool call, `e.requestId` the drawn row's id (a tool
// row's is its `tool_use_id`). So the window is told by id, not by `away.since`:
//   - a row drawn, or a tool call started, while the session is home is `seen`: it predates the
//     hold and is drawn as Claude Code draws it for the rest of the conversation;
//   - while away, a row whose id was never seen belongs to the hold and is hidden; a `ToolGroup`
//     is hidden only when none of its calls was seen;
//   - when the hold ends every id hidden in it becomes `seen`, so a later hold hides only its own
//     rows, even rows the host never drew again after `back`;
//   - a row drawn before the first query answered (the mod does not yet know whether the session
//     is away) is drawn as is and not recorded, so a conversation reopened while away hides every
//     row the mod has not seen at home, older ones included (no time to tell them apart).
// An `AssistantMessage` whose text carries an `on fire:` line (lib/sections.mjs, the Stop hook's
// parser) is never hidden. Hidden rows are runs: the first row of a run draws the dim line, the
// rows after it, in the order the mod first saw them, draw an empty Box; a shown row (a fire, a
// prompt Jo typed, a row from before the hold) ends the run.
//
// Only ids and a hidden/shown flag per row are kept, in memory; never a row's text. The on-fire
// check reads the text in memory and keeps nothing. Every set is capped at ID_CAP entries, the
// oldest dropped first.

import { splitNeedsYou } from "../../lib/sections.mjs";

/** What a hidden run draws, dim, in place of its first row. */
export const HELD_LINE = "held while away · say back";

/** The transcript row sites the mod hides while away. */
export const HIDDEN_SITES = ["AssistantMessage", "ToolUse", "ToolResult", "ToolGroup"];

/** The site that only marks the order of rows (a prompt Jo typed ends a run); never hidden. */
export const ORDER_SITE = "UserMessage";

/** The most ids one set keeps. */
export const ID_CAP = 20000;

/**
 * The engine system-prompt sections the away text is appended to: one of the two is in every
 * composition (Claude Code names the environment section one or the other). A plugin's own
 * section name is never asked for by `prompt.section`, so the text rides on this one.
 */
export const SECTION_NAMES = ["env_info_simple", "env_info_static"];

/**
 * What the agent reads while away: in the system prompt (`prompt.section`) and, once a turn,
 * after a tool's result (`tool.call` context), so a `brb` typed mid-turn reaches the running
 * turn. Fixed text: nothing in it comes from a file or from what anyone typed.
 */
export const AWAY_TEXT = [
  "# brb: Jo is away",
  "Jo typed brb and is away from the screen; until they say back, Claude Code shows them one dim line in place of your replies and tool calls.",
  "- Work without narration: no progress notes or summaries between tool calls.",
  "- Record each question, decision or approval with the hold command from brb's away instruction (`node \".../scripts/brb.mjs\" hold ...`), once per item, and leave it out of your reply.",
  "- Reply only with the still-away line (`brb: still away (...) — say `back` to read them`), the body, and, when nothing is runnable without Jo, a last line `idle: <why>`.",
  "- A line that starts `on fire:` still reaches Jo at once; keep it for what brb's away instruction names.",
].join("\n");

/** Whether `text` carries an on-fire line, as the Stop hook reads one (`on fire: none` is not one). */
export function carriesFire(text) {
  if (typeof text !== "string" || text === "") return false;
  try {
    return splitNeedsYou(text).onFire.length > 0;
  } catch {
    return false;
  }
}

/** The ids that place a row: a tool row's call id, a group's call ids, a message row's own id. */
export function rowIds(component, requestId, props) {
  const ids = [];
  if (component === "ToolGroup") {
    for (const call of Array.isArray(props?.calls) ? props.calls : []) if (typeof call?.tool_use_id === "string" && call.tool_use_id) ids.push(call.tool_use_id);
  } else if (component === "ToolUse" || component === "ToolResult") {
    if (typeof props?.tool_use_id === "string" && props.tool_use_id) ids.push(props.tool_use_id);
  }
  if (ids.length === 0 && typeof requestId === "string" && requestId) ids.push(requestId);
  return ids;
}

function capAdd(set, value) {
  set.add(value);
  if (set.size > ID_CAP) set.delete(set.values().next().value);
}

function capSet(map, key, value) {
  map.set(key, value);
  if (map.size > ID_CAP) map.delete(map.keys().next().value);
}

/**
 * The away-window ledger for one conversation.
 *
 *   decide({ known, away, component, requestId, props })
 *     → "show" (draw as Claude Code draws it), "line" (the dim line) or "empty" (nothing).
 *   noteCall(id, { known, away })   a tool call started: home, it predates any later hold.
 *   endHold()                       the hold ended: what it hid is from before the next one.
 *   held                            how many rows the current hold hides.
 */
export function createLedger() {
  /** Ids known to predate the current hold. */
  const seen = new Set();
  /** Ids hidden in the current hold. */
  const heldIds = new Set();
  /** Row key → the key of the row first seen before it (null for the first). */
  const prev = new Map();
  /** Row key → whether it is hidden as last drawn. */
  const hidden = new Map();
  let last = null;

  /** Place a row in first-seen order and record whether it is hidden now. */
  function place(key, isHidden) {
    if (!prev.has(key)) {
      capSet(prev, key, last);
      last = key;
    }
    capSet(hidden, key, isHidden);
  }

  return {
    get held() {
      return heldIds.size;
    },
    noteCall(id, { known, away }) {
      if (known && !away && typeof id === "string" && id) capAdd(seen, id);
    },
    decide({ known, away, component, requestId, props }) {
      const ids = rowIds(component, requestId, props);
      const key = `${component}:${ids[0] ?? ""}`;
      if (!known || component === ORDER_SITE || !HIDDEN_SITES.includes(component) || ids.length === 0) {
        if (ids.length) place(key, false);
        return "show";
      }
      if (!away) {
        for (const id of ids) capAdd(seen, id);
        place(key, false);
        return "show";
      }
      if (ids.some((id) => seen.has(id)) || (component === "AssistantMessage" && carriesFire(props?.text))) {
        place(key, false);
        return "show";
      }
      for (const id of ids) capAdd(heldIds, id);
      place(key, true);
      const before = prev.get(key);
      return before !== null && before !== undefined && hidden.get(before) === true ? "empty" : "line";
    },
    endHold() {
      for (const id of heldIds) capAdd(seen, id);
      heldIds.clear();
    },
  };
}

/**
 * The environment section with the away text appended while away; core's text unchanged while
 * home. `breakPromptCache` only when the away state differs from the last answer, so the cache
 * starts over at `brb` and at `back`, never on an unrelated re-ask.
 */
export function sectionAnswer(coreText, away, lastAway) {
  const text = away ? (typeof coreText === "string" && coreText ? `${coreText}\n\n${AWAY_TEXT}` : AWAY_TEXT) : (coreText ?? null);
  return away === lastAway ? { text } : { text, breakPromptCache: true };
}
