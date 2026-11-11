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
// check reads the text in memory and keeps nothing. The id sets never drop an id, and a row's ids
// (a group's calls) go in together or not at all: once they would pass ID_CAP the ledger is
// `full` and, for the rest of the conversation, hides only rows it already hid in the current
// hold; every other row draws as is (an id it could not keep might be
// an old row's, so it is never taken for a new one). The order maps (runs only) drop their oldest
// entry past ID_CAP, which at worst draws one more dim line.

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
 *   full                            an id could not be kept: only rows already hidden stay hidden.
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
  let full = false;

  /**
   * Keep every id in `set`, or none of them: the new distinct ids are counted first, so a group
   * that does not fit leaves no call of it behind. When they do not fit the ledger is full for
   * good. True when all were kept.
   */
  function keepAll(set, ids) {
    const fresh = new Set();
    for (const id of ids) if (!set.has(id)) fresh.add(id);
    if (set.size + fresh.size > ID_CAP) {
      full = true;
      return false;
    }
    for (const id of fresh) set.add(id);
    return true;
  }

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
    get full() {
      return full;
    },
    noteCall(id, { known, away }) {
      if (known && !away && typeof id === "string" && id) keepAll(seen, [id]);
    },
    decide({ known, away, component, requestId, props }) {
      const ids = rowIds(component, requestId, props);
      const key = `${component}:${ids[0] ?? ""}`;
      if (!known || component === ORDER_SITE || !HIDDEN_SITES.includes(component) || ids.length === 0) {
        if (ids.length) place(key, false);
        return "show";
      }
      if (!away) {
        keepAll(seen, ids);
        place(key, false);
        return "show";
      }
      if (ids.some((id) => seen.has(id)) || (component === "AssistantMessage" && carriesFire(props?.text))) {
        place(key, false);
        return "show";
      }
      // Full: an id not kept might be an old row's; only a row this hold already hid stays hidden.
      const hide = full ? ids.every((id) => heldIds.has(id)) : keepAll(heldIds, ids);
      if (!hide) {
        place(key, false);
        return "show";
      }
      place(key, true);
      const before = prev.get(key);
      return before !== null && before !== undefined && hidden.get(before) === true ? "empty" : "line";
    },
    endHold() {
      keepAll(seen, heldIds);
      heldIds.clear();
    },
  };
}

/**
 * What the environment-section hook returns: core's (or a later hook's) answer with every field
 * kept, the away text appended to its text while away. `breakPromptCache` is true when that
 * answer asked for it or when the away state differs from the one this section name last carried
 * (so the cache starts over at `brb` and at `back`, never on an unrelated re-ask). Home with no
 * change, the answer is returned as it came.
 */
export function sectionAnswer(core, away, lastAway) {
  const changed = away !== lastAway;
  if (!away && !changed) return core;
  const base = core && typeof core === "object" ? core : {};
  const coreText = typeof base.text === "string" ? base.text : null;
  const text = away ? (coreText ? `${coreText}\n\n${AWAY_TEXT}` : AWAY_TEXT) : coreText;
  // Every field of the answer is kept, its own `breakPromptCache` included; ours only adds a break.
  const answer = { ...base, text };
  if (changed) answer.breakPromptCache = true;
  return answer;
}

/**
 * section.json's text → the away state each environment section last carried in this session's
 * saved system prompt: `{ [name]: boolean }`, only SECTION_NAMES keys with boolean values. Missing
 * (null), unparsable or mis-shaped text is `{}`: nothing known, so nothing breaks the cache.
 * Never throws.
 */
export function parseSectionState(text) {
  const saved = {};
  if (typeof text !== "string") return saved;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return saved;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return saved;
  for (const name of SECTION_NAMES) if (typeof parsed[name] === "boolean") saved[name] = parsed[name];
  return saved;
}

/**
 * The away state a section name last carried in this conversation. Once the conversation has
 * answered it, that answer. At its first answer (a new conversation, a resume, a restarted Claude
 * Code), only this session's own section.json counts: saved away is away (the saved prompt may
 * carry the away text). A session never saved away, no file, or one that does not parse is home,
 * so a resume never breaks the cache for nothing, whatever an earlier conversation answered.
 */
export function lastCarried(answered, saved, name) {
  if (answered.has(name)) return answered.get(name) === true;
  return saved?.[name] === true;
}
