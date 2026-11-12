// data.mjs — the band's pure data: the snapshot query.mjs prints read back into one typed shape,
// the argv of the two scripts the mod runs, the duration format, the fallback status line (the
// one line `$.ui.status` shows where the band never renders), and the paths of the session's
// away.json and checklist.json (the mod's cheap "did anything appear" probes between queries).
//
// No imports: this file is loaded inside Claude Code by the hooks module (register.mjs), where
// only relative imports and `claude-code` are allowed, and by `node --test` for its unit tests.

/** The word that ends the hold; the band suggests it in the prompt box, and the Back button sends it. */
export const BACK_WORD = "back";

/**
 * The prompt a band press on the returned digest sends (hooks/user-prompt-submit.mjs reads it
 * through lib/text.mjs digestWord): Show → `brb item N`, Done → `brb done N`, Clear → `brb clear`,
 * each followed by ` @<at>` when `at` (the open list's checklist.json `at`) is given, so the hook
 * can refuse a press that arrives after its list was replaced or a new hold began.
 * `index` is the 0-based row; null for anything else.
 */
export function pickPrompt(verb, index, at = null) {
  const tag = typeof at === "string" && at && !/\s/.test(at) ? ` @${at}` : "";
  if (verb === "clear") return `brb clear${tag}`;
  if (!Number.isInteger(index) || index < 0) return null;
  if (verb === "item") return `brb item ${index + 1}${tag}`;
  if (verb === "done") return `brb done ${index + 1}${tag}`;
  return null;
}

/** The longest the fallback status line may be: 40 characters. */
export const STATUS_MAX = 40;

/** The most bytes query.mjs reads from any one state file; a larger file is a fault, never a parse. */
export const MAX_BYTES = 65536;

/** The argv after `node` that runs the query for `sessionId`: `[<script>, "--session", <id>]`. */
export function queryArgv(script, sessionId) {
  return [script, "--session", String(sessionId ?? "")];
}

/** The argv after `node` that runs an action: `[<script>, "--session", <id>, <verb>]`, with the row index after `done`. */
export function actArgv(script, sessionId, verb, index) {
  const argv = [script, "--session", String(sessionId ?? ""), String(verb)];
  if (index !== undefined) argv.push(String(index));
  return argv;
}

/** The snapshot before the first query answers: home, no checklist. */
export function emptySnapshot() {
  return { ok: true, away: false, checklist: null };
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

/** A checklist as query.mjs prints it → typed, or null for anything that is not one. */
export function readChecklistValue(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) return null;
  const items = value.items.filter((i) => i && typeof i === "object" && typeof i.text === "string").map((i) => ({ text: i.text, done: i.done === true }));
  return { at: typeof value.at === "string" ? value.at : "", since: typeof value.since === "string" ? value.since : "", note: typeof value.note === "string" ? value.note : "", items };
}

/**
 * What query.mjs printed → a snapshot the band can draw, with every field present and typed:
 *   { ok: true, away: false, checklist: null | { at, since, note, items: [{ text, done }] }, hideRows }
 *   { ok: true, away: true, since, note, held, onFire, items: [string], hideRows }
 *   { ok: false, error }
 * `hideRows` is false only when query.mjs printed false (config.json turned row hiding off).
 * Anything unparseable or mis-shaped becomes `{ ok: false, error }`, never a throw.
 */
export function readSnapshot(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? "").trim());
  } catch {
    return { ok: false, error: "query printed no JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "query printed no object" };
  if (parsed.ok === false) return { ok: false, error: String(parsed.error ?? "query failed") };
  const hideRows = parsed.hideRows !== false;
  if (parsed.away !== true) return { ok: true, away: false, checklist: readChecklistValue(parsed.checklist), hideRows };
  if (typeof parsed.since !== "string") return { ok: false, error: "query printed an away record with no since" };
  return {
    ok: true,
    away: true,
    since: parsed.since,
    note: typeof parsed.note === "string" ? parsed.note : "",
    held: count(parsed.held),
    onFire: count(parsed.onFire),
    items: strings(parsed.items),
    hideRows,
  };
}

/**
 * What act.mjs printed → `{ ok: true }` (with `away`, and `since` when away, when the action
 * printed them, as `back` does; with `open`, and `at` when open, as `open` does) or
 * `{ ok: false, error }`; junk is an error, never a throw.
 */
export function readResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? "").trim());
  } catch {
    return { ok: false, error: "action printed no JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "action printed no object" };
  if (parsed.ok !== true) return { ok: false, error: String(parsed.error ?? "action failed") };
  if (typeof parsed.open === "boolean") return parsed.open && typeof parsed.at === "string" ? { ok: true, open: true, at: parsed.at } : { ok: true, open: false };
  if (typeof parsed.away !== "boolean") return { ok: true };
  return parsed.away && typeof parsed.since === "string" ? { ok: true, away: true, since: parsed.since } : { ok: true, away: parsed.away };
}

/**
 * How long since `iso`, to the minute: `0m`, `40m`, `1h 5m`, `2d 3h`, the same arithmetic as
 * lib/text.mjs `awayFor` (the still-away line), repeated here because this file may import nothing;
 * a future or unparsable `since` is `0m`.
 */
export function elapsed(iso, now = Date.now()) {
  const t = Date.parse(iso);
  const m = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0;
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/**
 * The fallback status line, for a host that never asks the band to draw: at most STATUS_MAX
 * characters, or null when there is nothing to show (home, or a query that failed). The app
 * draws it after `⚠ brb:`, so the line does not repeat the name:
 *   away 40m · lunch · 12 held · say back     (the `brb <note>` text, whitespace collapsed)
 *   away 40m · 12 held · say back             (no note, or the note would pass STATUS_MAX: dropped whole)
 *   away 12d 3h · 123456789012 held           (`say back` would pass STATUS_MAX: dropped next)
 * A line still over STATUS_MAX (a count longer still) is cut to STATUS_MAX with an ellipsis.
 * After `back`, with a checklist on disk: `back · 3 to act on`.
 */
export function statusText(snapshot, { now = Date.now() } = {}) {
  if (!snapshot.ok) return null;
  if (!snapshot.away) {
    const open = snapshot.checklist?.items.filter((i) => !i.done).length ?? 0;
    return open ? `${BACK_WORD} · ${open} to act on` : null;
  }
  const since = `away ${elapsed(snapshot.since, now)}`;
  const held = `${snapshot.held} held`;
  const say = `say ${BACK_WORD}`;
  const note = snapshot.note.replace(/\s+/g, " ").trim();
  const fits = [note && [since, note, held, say].join(" · "), [since, held, say].join(" · "), [since, held].join(" · ")].find((t) => t && t.length <= STATUS_MAX);
  return fits ?? `${[since, held].join(" · ").slice(0, STATUS_MAX - 1)}…`;
}

/** The text the band proposes for the empty prompt box while away: `away 40m — type back`. */
export function suggestionText(snapshot, { now = Date.now() } = {}) {
  if (!snapshot.ok || !snapshot.away) return null;
  return `away ${elapsed(snapshot.since, now)} — type ${BACK_WORD}`;
}

/** lib/state.mjs `sessionKey`, repeated here because this file may import nothing: the session id as a directory name. */
export function sessionKey(sessionId) {
  const s = typeof sessionId === "string" ? sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_") : "";
  return s && s !== "." && s !== ".." ? s.slice(0, 120) : "no-session";
}

/** `${XDG_STATE_HOME:-$HOME/.local/state}/brb/<session key>/<file>`; null when neither variable has a value. */
function sessionFile({ xdgStateHome, home, sessionId }, file) {
  const root = xdgStateHome?.trim() ? xdgStateHome : home ? `${home.replace(/[\\/]+$/, "")}/.local/state` : null;
  if (!root) return null;
  return `${root.replace(/[\\/]+$/, "")}/brb/${sessionKey(sessionId)}/${file}`;
}

/**
 * `${XDG_STATE_HOME:-$HOME/.local/state}/brb/<session key>/away.json`, as lib/state.mjs places it;
 * null when neither variable has a value (the mod then relies on its query alone).
 */
export function awayPath(where) {
  return sessionFile(where, "away.json");
}

/**
 * `…/brb/<session key>/section.json`: the away state each environment section last carried in
 * this session's system prompt (lib/state.mjs lists it); null when neither variable has a value.
 */
export function sectionPath(where) {
  return sessionFile(where, "section.json");
}
